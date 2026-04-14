/**
 * OCR 服务 — 直接调用 PaddleOCR 官方云端 API
 *
 * 通过 Vite dev proxy（生产环境需配置 nginx 做同样转发）绕过 CORS
 */

import { loadOCRConfig } from './ocrConfig'

// 通过 Vite dev proxy 绕过 CORS
const CLOUD_JOB_URL = '/paddleocr-proxy/api/v2/ocr/jobs'

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
  _params: Record<string, unknown>,
): Promise<OcrApiResult[]> {
  const cfg = loadOCRConfig()
  if (!cfg.api_token) throw new Error('请先在设置页配置 PaddleOCR API Token')
  return recognizeCloud(base64, cfg.api_token, cfg.model || 'PP-OCRv5')
}

// ── PaddleOCR 云端直调 ────────────────────────────────────────────────────────

async function recognizeCloud(
  base64: string,
  apiToken: string,
  model: string,
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

  const submitRes = await fetch(CLOUD_JOB_URL, { method: 'POST', headers, body: form })
  if (!submitRes.ok) {
    const text = await submitRes.text()
    throw new Error(`提交 OCR 任务失败 ${submitRes.status}: ${text.slice(0, 200)}`)
  }
  const { data: { jobId } } = await submitRes.json()

  // 2. 轮询直到任务完成（最长 2 分钟）
  let jsonlUrl = ''
  for (let i = 0; i < 60; i++) {
    await sleep(2000)
    const pollRes = await fetch(`${CLOUD_JOB_URL}/${jobId}`, { headers })
    if (!pollRes.ok) continue
    const pollData = await pollRes.json()
    const state: string = pollData.data.state
    if (state === 'done') {
      jsonlUrl = pollData.data.resultUrl.jsonUrl
      break
    }
    if (state === 'failed') {
      throw new Error(`云端 OCR 任务失败: ${pollData.data.errorMsg ?? 'unknown'}`)
    }
  }

  if (!jsonlUrl) throw new Error('云端 OCR 超时（>2 分钟）')

  // 3. 下载并解析 JSONL 结果（通过 Vite proxy 绕过 bcebos.com CORS）
  const proxiedJsonlUrl = jsonlUrl.replace('https://bj.bcebos.com', '/bcebos-proxy')
  const resultRes = await fetch(proxiedJsonlUrl)
  if (!resultRes.ok) throw new Error(`结果下载失败: ${resultRes.status}`)
  const raw = parseCloudJsonl(await resultRes.text())
  return mergeOcrResults(raw)
}

// ── JSONL 解析（兼容 PaddleX / PP-OCRv3 / PP-OCRv5 输出格式）─────────────────

function parseCloudJsonl(jsonlText: string): OcrApiResult[] {
  const results: OcrApiResult[] = []

  for (const line of jsonlText.trim().split('\n')) {
    if (!line.trim()) continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

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
  expandRatio = 1.2,
  maxDistance = 30,
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

  // 与后端一致：按置信度降序排列
  merged.sort((a, b) => b.confidence - a.confidence)
  return merged
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
