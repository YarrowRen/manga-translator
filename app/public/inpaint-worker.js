/**
 * Inpaint Web Worker
 * 接收: { rgbData: Uint8ClampedArray, maskData: Uint8Array, width, height }
 * 发送: { rgbaData: Uint8ClampedArray } 或 { error: string }
 *
 * opencv.js 通过 importScripts 加载，WASM 在 worker 内初始化，不阻塞主线程。
 */

self.Module = {
  onRuntimeInitialized() {
    self.cvReady = true
    // 若有等待中的任务，立即处理
    if (self.pendingMsg) {
      processMsg(self.pendingMsg)
      self.pendingMsg = null
    }
  }
}

try {
  importScripts('/opencv.js')
} catch (e) {
  self.postMessage({ error: 'opencv.js 加载失败: ' + e.message })
}

self.onmessage = function (e) {
  if (!self.cvReady) {
    self.pendingMsg = e
    return
  }
  processMsg(e)
}

function processMsg(e) {
  const { rgbData, maskData, width, height } = e.data
  try {
    const cv = self.cv

    // 构建 RGB Mat
    const srcRGB = new cv.Mat(height, width, cv.CV_8UC3)
    srcRGB.data.set(rgbData)

    // 构建 mask Mat
    const maskMat = new cv.Mat(height, width, cv.CV_8UC1)
    maskMat.data.set(maskData)

    // 执行 inpaint
    const dst = new cv.Mat()
    cv.inpaint(srcRGB, maskMat, dst, 20, cv.INPAINT_TELEA)

    // 转为 RGBA（α=255）
    const dstRGBA = new cv.Mat()
    cv.cvtColor(dst, dstRGBA, cv.COLOR_RGB2RGBA)

    const result = new Uint8ClampedArray(dstRGBA.data)

    srcRGB.delete()
    maskMat.delete()
    dst.delete()
    dstRGBA.delete()

    self.postMessage({ rgbaData: result }, [result.buffer])
  } catch (err) {
    self.postMessage({ error: String(err) })
  }
}
