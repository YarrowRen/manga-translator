/**
 * OCR 配置 — 存取 localStorage
 * 直接调用 PaddleOCR 官方云 API（通过 Vite dev proxy 绕过 CORS）
 */

export interface OCRConfig {
  api_token: string   // AI Studio API Token
  model: string       // 模型，如 PP-OCRv5
}

const STORAGE_KEY = 'manga_trans_ocr_config'

const DEFAULT_CONFIG: OCRConfig = {
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
