/**
 * OCR 服务 — 直接调用 PaddleOCR 官方云端 API
 *
 * 通过 Vite dev proxy（生产环境需配置 nginx 做同样转发）绕过 CORS
 *
 * 接口优先级：
 *   1. 同步接口（境外优化域名）— 单次请求直接返回结果，无轮询，无 bcebos 下载
 *   2. 异步接口（fallback）    — 提交 job → 轮询 → 下载 JSONL
 */

import { loadOCRConfig } from './ocrConfig'

// 异步 job 接口（国内优化）
const CLOUD_JOB_URL  = '/paddleocr-proxy/api/v2/ocr/jobs'
// 同步接口（境外优化，直接返回结果）
const CLOUD_FAST_URL = '/paddleocr-fast-proxy/ocr'

export interface OcrApiResult {
  text: string
  confidence: number
  bbox: number[]
  polygon: number[][] | null
  is_merged: boolean
  original_count: number
  original_texts: string[]
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

export async function recognizeText(
  base64: string,
  params: Record<string, unknown>,
): Promise<OcrApiResult[]> {
  const cfg = loadOCRConfig()
  if (!cfg.api_token) throw new Error('请先在设置页配置 PaddleOCR API Token')
  const raw = await recognizeCloud(base64, cfg.api_token, cfg.model || 'PP-OCRv5')

  // 允许调用方覆盖合并参数
  const expandRatio  = typeof params.mergeExpandRatio  === 'number' ? params.mergeExpandRatio  : undefined
  const maxDistance  = typeof params.mergeMaxDistance  === 'number' ? params.mergeMaxDistance  : undefined
  const minGroupSize = typeof params.mergeMinGroupSize === 'number' ? params.mergeMinGroupSize : undefined
  return mergeOcrResults(raw, expandRatio, maxDistance, minGroupSize)
}

// localhost / 127.0.0.1 判定为本地开发环境，直接走异步接口
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(window.location.hostname)

// ── 入口分发：本地走异步，远端优先同步（失败降级异步）────────────────────────

async function recognizeCloud(
  base64: string,
  apiToken: string,
  model: string,
): Promise<OcrApiResult[]> {
  const t0 = performance.now()
  const ms = (from: number) => `${(performance.now() - from).toFixed(0)}ms`

  const cfg = loadOCRConfig()
  const { compressed, scale } = cfg.compress_enabled
    ? await compressForOcr(base64, cfg.compress_max_side, cfg.compress_quality)
    : { compressed: base64, scale: 1 }

  let raw: OcrApiResult[]
  if (IS_LOCAL) {
    raw = await recognizeCloudAsync(compressed, apiToken, model, t0, ms)
  } else {
    try {
      raw = await recognizeCloudFast(compressed, apiToken, t0, ms)
    } catch (e: any) {
      console.warn(`[OCR] 同步接口失败 (${ms(t0)})，降级到异步接口: ${e.message}`)
      raw = await recognizeCloudAsync(compressed, apiToken, model, t0, ms)
    }
  }

  // 坐标还原到原图空间
  return scale < 1 ? raw.map(r => scaleOcrResult(r, 1 / scale)) : raw
}

// ── 图片压缩 ──────────────────────────────────────────────────────────────────

async function compressForOcr(
  base64: string,
  maxSide: number,
  quality: number,
): Promise<{ compressed: string; scale: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = maxSide > 0
        ? Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
        : 1
      if (scale >= 1 && quality >= 1) { resolve({ compressed: base64, scale: 1 }); return }

      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
      console.log(`[OCR] 压缩 ${img.naturalWidth}×${img.naturalHeight} → ${w}×${h} (scale=${scale.toFixed(3)}, quality=${quality})`)
      resolve({ compressed: canvas.toDataURL('image/jpeg', quality), scale })
    }
    img.onerror = reject
    img.src = base64
  })
}

/** 将 OCR 返回的坐标按比例还原到原图空间 */
function scaleOcrResult(r: OcrApiResult, factor: number): OcrApiResult {
  return {
    ...r,
    bbox: r.bbox.map(v => v * factor),
    polygon: r.polygon ? r.polygon.map(([x, y]) => [x * factor, y * factor]) : null,
  }
}

// ── 同步接口 ──────────────────────────────────────────────────────────────────

async function recognizeCloudFast(
  base64: string,
  apiToken: string,
  t0: number,
  ms: (from: number) => string,
): Promise<OcrApiResult[]> {
  // 去掉 data URL 前缀，只保留纯 base64 字符串
  const b64 = base64.includes(',') ? base64.split(',')[1] : base64

  const t1 = performance.now()
  const res = await fetch(CLOUD_FAST_URL, {
    method: 'POST',
    headers: {
      'Authorization': `token ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file: b64,
      fileType: 1,
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useTextlineOrientation: false,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`同步 OCR 失败 ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = await res.json()
  const results = parseOcrObject(data)
  console.log(`[OCR] 同步接口完成: ${ms(t1)}  总耗时: ${ms(t0)}  识别数: ${results.length}`)
  return results
}

// ── 异步接口（原有逻辑）───────────────────────────────────────────────────────

async function recognizeCloudAsync(
  base64: string,
  apiToken: string,
  model: string,
  t0: number,
  ms: (from: number) => string,
): Promise<OcrApiResult[]> {
  const headers = { Authorization: `bearer ${apiToken}` }

  // 1. 将 base64 data URL 转为 Blob，用 FormData 提交
  const { blob, ext } = dataUrlToBlob(base64)
  const form = new FormData()
  form.append('model', model)
  form.append('optionalPayload', JSON.stringify({
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useTextlineOrientation: false,
  }))
  form.append('file', blob, `image.${ext}`)

  const t1 = performance.now()
  const submitRes = await fetch(CLOUD_JOB_URL, { method: 'POST', headers, body: form })
  if (!submitRes.ok) {
    const text = await submitRes.text()
    throw new Error(`提交 OCR 任务失败 ${submitRes.status}: ${text.slice(0, 200)}`)
  }
  const { data: { jobId } } = await submitRes.json()
  console.log(`[OCR] ① 上传+提交任务: ${ms(t1)}  jobId=${jobId}`)

  // 2. 轮询直到任务完成（最长 2 分钟）
  let jsonlUrl = ''
  const t2 = performance.now()
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const tPoll = performance.now()
    const pollRes = await fetch(`${CLOUD_JOB_URL}/${jobId}`, { headers })
    if (!pollRes.ok) continue
    const pollData = await pollRes.json()
    const state: string = pollData.data.state
    console.log(`[OCR] ② 轮询 #${i + 1} (${ms(tPoll)}) state=${state}`)
    if (state === 'done') {
      jsonlUrl = pollData.data.resultUrl.jsonUrl
      break
    }
    if (state === 'failed') {
      throw new Error(`云端 OCR 任务失败: ${pollData.data.errorMsg ?? 'unknown'}`)
    }
  }
  console.log(`[OCR] ② 等待完成总耗时: ${ms(t2)}`)

  if (!jsonlUrl) throw new Error('云端 OCR 超时（>2 分钟）')

  // 3. 下载并解析 JSONL 结果（通过 Vite proxy 绕过 bcebos.com CORS）
  const proxiedJsonlUrl = jsonlUrl.replace('https://bj.bcebos.com', '/bcebos-proxy')
  const t3 = performance.now()
  const resultRes = await fetch(proxiedJsonlUrl)
  if (!resultRes.ok) throw new Error(`结果下载失败: ${resultRes.status}`)
  const jsonlText = await resultRes.text()
  console.log(`[OCR] ③ 下载结果: ${ms(t3)}  size=${jsonlText.length}B`)
  console.log(`[OCR] 全程总耗时: ${ms(t0)}`)
  return parseCloudJsonl(jsonlText)
}

// ── 结果解析 ──────────────────────────────────────────────────────────────────

/** 解析单个 JSON 对象（同步接口响应） */
function parseOcrObject(obj: any): OcrApiResult[] {
  const results: OcrApiResult[] = []
  const ocrResults: any[] = obj?.result?.ocrResults ?? []
  for (const page of ocrResults) {
    const pruned = page.prunedResult ?? page
    const texts:  string[]     = pruned.rec_texts  ?? []
    const scores: number[]     = pruned.rec_scores ?? []
    const polys:  number[][][] = pruned.rec_polys  ?? pruned.dt_polys ?? []

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]?.trim()
      if (!text) continue
      const poly = polys[i] ?? []
      const xs = poly.map((p: number[]) => p[0])
      const ys = poly.map((p: number[]) => p[1])
      results.push({
        text,
        confidence: scores[i] ?? 0,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        polygon: poly.length ? poly : null,
        is_merged: false,
        original_count: 1,
        original_texts: [text],
      })
    }
  }
  return results
}

/** 解析 JSONL 文本（异步接口结果，每行一个 JSON 对象） */
function parseCloudJsonl(jsonlText: string): OcrApiResult[] {
  const results: OcrApiResult[] = []
  for (const line of jsonlText.trim().split('\n')) {
    if (!line.trim()) continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    results.push(...parseOcrObject(obj))
  }
  return results
}

// ── 对话框合并（移植自后端 DialogMerger）─────────────────────────────────────

class Rect {
  x0: number; y0: number; x1: number; y1: number; w: number; h: number
  constructor(x: number, y: number, w: number, h: number) {
    this.x0 = x; this.y0 = y; this.x1 = x + w; this.y1 = y + h
    this.w = w; this.h = h
  }
  collision(r: Rect) {
    return this.x0 < r.x1 && this.y0 < r.y1 && this.x1 > r.x0 && this.y1 > r.y0
  }
  distanceTo(r: Rect) {
    const cx1 = (this.x0 + this.x1) / 2, cy1 = (this.y0 + this.y1) / 2
    const cx2 = (r.x0 + r.x1) / 2,       cy2 = (r.y0 + r.y1) / 2
    return Math.hypot(cx1 - cx2, cy1 - cy2)
  }
  expand(ratio: number) {
    const ew = this.w * ratio - this.w, eh = this.h * ratio - this.h
    return new Rect(this.x0 - ew / 2, this.y0 - eh / 2, this.w + ew, this.h + eh)
  }
}

function bboxToRect(bbox: number[]) {
  return new Rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1])
}

function findNearby(
  rect: Rect,
  allRects: [Rect, number][],
  used: Set<number>,
  expandRatio: number,
  maxDist: number,
): number[] {
  const expanded = rect.expand(expandRatio)
  return allRects
    .filter(([r, idx]) => !used.has(idx) && (expanded.collision(r) || rect.distanceTo(r) <= maxDist))
    .map(([, idx]) => idx)
}

function findConnected(
  rect: Rect,
  allRects: [Rect, number][],
  used: Set<number>,
  group: number[],
  expandRatio: number,
  maxDist: number,
) {
  for (const idx of findNearby(rect, allRects, used, expandRatio, maxDist)) {
    if (used.has(idx)) continue
    group.push(idx)
    used.add(idx)
    const nextRect = allRects.find(([, i]) => i === idx)![0]
    findConnected(nextRect, allRects, used, group, expandRatio, maxDist)
  }
}

function mergeOcrResults(
  items: OcrApiResult[],
  expandRatio = 1.05,
  maxDistance = 10,
  minGroupSize = 2,
): OcrApiResult[] {
  if (!items.length) return []

  // 按面积从大到小作为种子
  const rects: [Rect, number][] = items.map((r, i) => [bboxToRect(r.bbox), i])
  rects.sort(([a], [b]) => b.w * b.h - a.w * a.h)

  const used = new Set<number>()
  const groups: number[][] = []

  for (const [rect, idx] of rects) {
    if (used.has(idx)) continue
    const group = [idx]
    used.add(idx)
    findConnected(rect, rects, used, group, expandRatio, maxDistance)
    groups.push(group)
  }

  const merged: OcrApiResult[] = []

  for (const group of groups) {
    if (group.length >= minGroupSize) {
      // 组内按中心 X 右→左排序（漫画竖排阅读方向）
      const sorted = group
        .map(i => ({ i, r: items[i], cx: (items[i].bbox[0] + items[i].bbox[2]) / 2 }))
        .sort((a, b) => b.cx - a.cx)

      const allX = sorted.flatMap(({ r }) => [r.bbox[0], r.bbox[2]])
      const allY = sorted.flatMap(({ r }) => [r.bbox[1], r.bbox[3]])
      const allPts: number[][] = []
      for (const { r } of sorted) {
        if (r.polygon?.length) allPts.push(...r.polygon)
        else {
          const [x1, y1, x2, y2] = r.bbox
          allPts.push([x1, y1], [x2, y1], [x2, y2], [x1, y2])
        }
      }

      merged.push({
        text:           sorted.map(({ r }) => r.text).join(' '),
        confidence:     sorted.reduce((s, { r }) => s + r.confidence, 0) / sorted.length,
        bbox:           [Math.min(...allX), Math.min(...allY), Math.max(...allX), Math.max(...allY)],
        polygon:        convexHull(allPts),
        is_merged:      true,
        original_count: sorted.length,
        original_texts: sorted.map(({ r }) => r.text),
      })
    } else {
      for (const i of group) merged.push(items[i])
    }
  }

  // 按漫画阅读顺序：先按 maxX 聚类成列（右→左），再列内按 minY 排序（上→下）
  // 列边界阈值 = 平均气泡宽度 * 1.4，自适应不同页面
  const avgWidth = merged.reduce((s, r) => s + (r.bbox[2] - r.bbox[0]), 0) / merged.length
  const colThreshold = avgWidth * 1.4

  const sortedByX = [...merged].sort((a, b) => b.bbox[2] - a.bbox[2])
  const columns: (typeof merged)[] = []
  let currentCol: typeof merged = []

  for (const r of sortedByX) {
    if (currentCol.length === 0 || currentCol[0].bbox[2] - r.bbox[2] < colThreshold) {
      currentCol.push(r)
    } else {
      columns.push(currentCol)
      currentCol = [r]
    }
  }
  if (currentCol.length) columns.push(currentCol)

  // 每列内按 minY 升序（上→下）
  for (const col of columns) col.sort((a, b) => a.bbox[1] - b.bbox[1])

  return columns.flat()
}

// ── 凸包（Graham scan，替代后端 cv2.convexHull）────────────────────────────────

function convexHull(pts: number[][]): number[][] {
  if (pts.length < 3) return pts
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (O: number[], A: number[], B: number[]) =>
    (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0])
  const lower: number[][] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper: number[][] = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop()
    upper.push(p)
  }
  lower.pop(); upper.pop()
  return [...lower, ...upper]
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function dataUrlToBlob(dataUrl: string): { blob: Blob; ext: string } {
  const [header, b64] = dataUrl.split(',', 2)
  const mimeType = header.split(';')[0].split(':')[1]
  const ext = mimeType.split('/')[1].replace('jpeg', 'jpg')
  const binary = atob(b64)
  const arr = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i)
  return { blob: new Blob([arr], { type: mimeType }), ext }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
