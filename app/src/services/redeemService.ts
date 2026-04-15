import { type LLMConfig } from './llmConfig'
import { type OCRConfig } from './ocrConfig'
import { type EhentaiConfig } from './ehentaiConfig'

interface RedeemResult {
  label: string
  config: {
    llm?: LLMConfig
    ocr?: OCRConfig
    ehentai?: EhentaiConfig
  }
}

export async function redeemCode(code: string): Promise<RedeemResult> {
  const res = await fetch('/api/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || '兑换失败')
  return { label: data.label ?? '', config: data.config }
}
