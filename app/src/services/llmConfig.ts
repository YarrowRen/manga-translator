/**
 * LLM 配置 — 存取 localStorage
 * 替代原后端 /api/settings 接口，配置持久化在用户浏览器本地。
 */

export interface LLMConfig {
  base_url: string
  api_key: string
  model: string
}

const STORAGE_KEY = 'manga_trans_llm_config'

const DEFAULT_CONFIG: LLMConfig = {
  base_url: 'https://api.openai.com/v1',
  api_key: '',
  model: 'gpt-4o-mini',
}

export function loadLLMConfig(): LLMConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) }
  } catch {}
  return { ...DEFAULT_CONFIG }
}

export function saveLLMConfig(cfg: LLMConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}
