/**
 * 文字消除服务 — 纯前端实现
 * 替代后端 /api/ocr/inpaint 接口。
 *
 * 算法与后端 inpaint_image() 完全对应：
 *   均匀背景（方差 < 500）→ Canvas 2D 直接填充均值色（fast path）
 *   复杂背景            → opencv.js cv.inpaint TELEA（按需动态加载）
 *
 * 注意：cv.inpaint 只接受 1 通道或 3 通道输入，处理时需将
 * Canvas 的 RGBA 转换为 RGB，完成后再转回。
 */

// ── Inpaint Web Worker ────────────────────────────────────────────────────────
//
// cv.inpaint 是 CPU 密集型操作，在主线程运行会冻结 UI。
// 通过 Web Worker（/inpaint-worker.js）在后台线程执行，主线程不阻塞。
//
// Worker 内使用 importScripts('/opencv.js') 加载 WASM，
// 不依赖 window.Module，避免 Vite 模块作用域问题。

// Worker 单例，懒创建
// Worker 内部用 pendingMsg 机制处理"消息在 WASM 就绪前到达"的情况，
// 主线程无需等待 ready 信号，直接发消息即可。
let _worker: Worker | null = null

function getWorker(): Worker {
  if (_worker) return _worker
  _worker = new Worker('/inpaint-worker.js')
  _worker.onerror = (e) => {
    console.error('inpaint-worker error:', e)
    _worker = null   // 下次重新创建
  }
  return _worker
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 消除图片中指定区域的文字，返回处理后的图片 PNG data URL。
 *
 * @param imageSrc  - 原图 base64 data URL 或 blob URL
 * @param bboxes    - [[x1,y1,x2,y2], ...] 文字区域
 * @param polygons  - 精确多边形（与 bboxes 一一对应，null 表示用 bbox 代替）
 */
export async function inpaintRegions(
  imageSrc: string,
  bboxes: number[][],
  polygons: (number[][] | null)[] | null,
): Promise<string> {
  const img = await loadImg(imageSrc)
  const w = img.naturalWidth
  const h = img.naturalHeight

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)

  // 一次性读取全图像素，避免重复 getImageData
  const imageData = ctx.getImageData(0, 0, w, h)
  const pixels = imageData.data  // Uint8ClampedArray, RGBA

  const simpleFills: { indices: number[]; color: [number, number, number] }[] = []
  const complexMask = new Uint8Array(w * h)  // 0 | 255，供 cv.inpaint 使用

  for (let i = 0; i < bboxes.length; i++) {
    const bbox = bboxes[i]
    const poly = polygons?.[i] ?? null

    const rx1 = Math.max(0, Math.round(bbox[0]))
    const ry1 = Math.max(0, Math.round(bbox[1]))
    const rx2 = Math.min(w, Math.round(bbox[2]))
    const ry2 = Math.min(h, Math.round(bbox[3]))
    if (rx2 <= rx1 || ry2 <= ry1) continue

    // 光栅化填充区域（仅处理 bbox 大小的子 canvas，效率高）
    const indices = rasterizeRegion(poly, rx1, ry1, rx2, ry2, w)

    // 采样背景色，与后端 _sample_background(border=20, variance<500) 完全一致
    const { isSimple, meanColor } = sampleBackground(pixels, rx1, ry1, rx2, ry2, w, h)

    if (isSimple) {
      simpleFills.push({ indices, color: meanColor })
    } else {
      for (const idx of indices) complexMask[idx] = 255
    }
  }

  // ── 均匀背景：直接填色 ───────────────────────────────────────────────────
  for (const { indices, color: [r, g, b] } of simpleFills) {
    for (const idx of indices) {
      pixels[idx * 4]     = r
      pixels[idx * 4 + 1] = g
      pixels[idx * 4 + 2] = b
      // alpha 不变
    }
  }
  ctx.putImageData(imageData, 0, 0)

  // ── 复杂背景：cv.inpaint TELEA（Web Worker，不阻塞主线程） ──────────────
  const hasComplex = complexMask.some(v => v > 0)
  if (hasComplex) {
    const worker = getWorker()

    // 重新读取（此时包含简单填色的结果），RGBA → RGB
    const freshData = ctx.getImageData(0, 0, w, h)
    const rgba = freshData.data
    const rgb = new Uint8ClampedArray(w * h * 3)
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3]     = rgba[i * 4]
      rgb[i * 3 + 1] = rgba[i * 4 + 1]
      rgb[i * 3 + 2] = rgba[i * 4 + 2]
    }

    const result = await new Promise<Uint8ClampedArray>((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        worker.removeEventListener('message', handler)
        if (e.data?.error) reject(new Error(e.data.error))
        else resolve(e.data.rgbaData)
      }
      worker.addEventListener('message', handler)
      worker.postMessage(
        { rgbData: rgb, maskData: complexMask, width: w, height: h },
        [rgb.buffer, complexMask.buffer],
      )
    })

    ctx.putImageData(new ImageData(result, w, h), 0, 0)
  }

  return canvas.toDataURL('image/png')
}

// ── 辅助：光栅化区域 ──────────────────────────────────────────────────────────

/**
 * 将多边形（或 bbox）光栅化为像素索引数组（full-image pixel index = y*w+x）。
 * 仅创建 bbox 大小的子 canvas，避免处理全图像素。
 */
function rasterizeRegion(
  polygon: number[][] | null,
  x1: number, y1: number, x2: number, y2: number,
  w: number,
): number[] {
  const bw = x2 - x1
  const bh = y2 - y1

  const mc = document.createElement('canvas')
  mc.width = bw
  mc.height = bh
  const mctx = mc.getContext('2d')!

  mctx.fillStyle = '#fff'
  if (polygon && polygon.length >= 3) {
    mctx.beginPath()
    // 坐标平移到 bbox 局部坐标系
    mctx.moveTo(polygon[0][0] - x1, polygon[0][1] - y1)
    for (let i = 1; i < polygon.length; i++) {
      mctx.lineTo(polygon[i][0] - x1, polygon[i][1] - y1)
    }
    mctx.closePath()
    mctx.fill()
  } else {
    mctx.fillRect(0, 0, bw, bh)
  }

  const md = mctx.getImageData(0, 0, bw, bh).data
  const indices: number[] = []
  for (let row = 0; row < bh; row++) {
    for (let col = 0; col < bw; col++) {
      if (md[(row * bw + col) * 4] > 128) {
        indices.push((y1 + row) * w + (x1 + col))
      }
    }
  }
  return indices
}

// ── 辅助：背景采样 ────────────────────────────────────────────────────────────

/**
 * 采样 bbox 外围 border 像素环，计算均值色和方差。
 * 完全对应后端 _sample_background(border=20, threshold=500)。
 */
function sampleBackground(
  data: Uint8ClampedArray,
  x1: number, y1: number, x2: number, y2: number,
  w: number, h: number,
  border = 20,
): { isSimple: boolean; meanColor: [number, number, number] } {
  const get = (x: number, y: number): [number, number, number] => {
    const i = (y * w + x) * 4
    return [data[i], data[i + 1], data[i + 2]]
  }

  const s: [number, number, number][] = []

  // 上下两侧
  for (let x = x1; x < x2; x++) {
    for (let d = 0; d < border; d++) {
      if (y1 - d - 1 >= 0) s.push(get(x, y1 - d - 1))
      if (y2 + d < h)      s.push(get(x, y2 + d))
    }
  }
  // 左右两侧
  for (let y = y1; y < y2; y++) {
    for (let d = 0; d < border; d++) {
      if (x1 - d - 1 >= 0) s.push(get(x1 - d - 1, y))
      if (x2 + d < w)      s.push(get(x2 + d, y))
    }
  }

  if (!s.length) return { isSimple: true, meanColor: [255, 255, 255] }

  const n = s.length
  let sR = 0, sG = 0, sB = 0
  for (const [r, g, b] of s) { sR += r; sG += g; sB += b }
  const mR = sR / n, mG = sG / n, mB = sB / n

  let vSum = 0
  for (const [r, g, b] of s) {
    vSum += (r - mR) ** 2 + (g - mG) ** 2 + (b - mB) ** 2
  }
  const variance = vSum / (n * 3)

  return {
    isSimple: variance < 500,
    meanColor: [Math.round(mR), Math.round(mG), Math.round(mB)],
  }
}

// ── 辅助：加载图片 ────────────────────────────────────────────────────────────

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
