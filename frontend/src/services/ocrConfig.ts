/**
 * OCR 配置 — 存取 localStorage
 * provider='local'  → 调用本地后端 PaddleOCR（需启动后端 + 安装 paddleocr）
 * provider='cloud'  → 调用 PaddleOCR 官方云 API（通过后端代理，需要 api_token）
 */

export interface OCRConfig {
  provider: 'local' | 'cloud'
  api_token: string   // cloud 模式专用
  model: string       // cloud 模式专用，如 PP-OCRv5
}

const STORAGE_KEY = 'manga_trans_ocr_config'

const DEFAULT_CONFIG: OCRConfig = {
  provider: 'local',
  api_token: '',
  model: 'PP-OCRv5',
}

export function loadOCRConfig(): OCRConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) }
  } catch {}
  return { ...DEFAULT_CONFIG }
}

export function saveOCRConfig(cfg: OCRConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}
