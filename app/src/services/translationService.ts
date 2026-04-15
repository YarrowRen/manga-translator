/**
 * 翻译服务 — 直接调用用户配置的 LLM API（OpenAI 兼容）
 * 替代原后端 /api/ocr/translate/batch 接口。
 * Prompt 与后端 translate_japanese_to_chinese_batch 完全一致。
 */

import { loadLLMConfig } from './llmConfig'

// ── 漫画翻译 Prompt ──────────────────────────────────────────────────────────

const EN_ZH_PROMPT = `**你的身份**

* 你是"英→中漫画翻译 agent"。你的唯一目标：在理解语境的前提下，把可能含有 OCR 错误的英文文本**纠正后**准确翻译为自然流畅的**简体中文**。
* 不进行创作与删改，不做剧透或点评，不自行审查或弱化用词；只做纠错与忠实翻译。

## 输入格式

\`\`\`json
{
  "1": "英文文本1",
  "2": "英文文本2"
}
\`\`\`

## 输出格式

只返回对应中文的 JSON：

\`\`\`json
{
  "1": "中文翻译1",
  "2": "中文翻译2"
}
\`\`\`

## 翻译流程

1. **纠错清洗** — 修正 OCR 错误，恢复自然语序
2. **语境判定** — 判别对白/独白/旁白/拟声词
3. **翻译策略** — 忠实准确，中文口语自然，保留粗口与俚语力度
4. **拟声词** — 意译为中文口语化表达，如 BANG→砰、BOOM→轰
5. **不确定性** — 模糊处加 \`〔? 备选：…〕\`

## 输出要求

* 仅输出中文译文 JSON，不输出原文或过程说明。
* 标点使用中文全角，省略号统一"……"。

请翻译：

`

const MANGA_PROMPT = `**你的身份**

* 你是"日→中漫画翻译 agent"。你的唯一目标：在理解语境的前提下，把可能含有 OCR 错误的日文文本**纠正后**准确翻译为自然流畅的**简体中文**。
* 不进行创作与删改，不做剧透或点评，不自行审查或弱化用词；只做纠错与忠实翻译。

## 输入格式

\`\`\`json
{
  "1": "日文文本1",
  "2": "日文文本2"
}
\`\`\`

## 输出格式

只返回对应中文的 JSON：

\`\`\`json
{
  "1": "中文翻译1",
  "2": "中文翻译2"
}
\`\`\`

## 翻译流程

1. **纠错清洗** — 修正 OCR 错误，恢复自然语序
2. **语境判定** — 判别对白/独白/旁白/拟声词
3. **术语与称谓** — さん→先生，ちゃん→小X，くん→君，様→大人，先輩→前辈
4. **翻译策略** — 忠实准确，中文口语自然，保留粗口与俚语力度
5. **拟声词** — \`原文（中文释义）\` 格式
6. **不确定性** — 模糊处加 \`〔? 备选：…〕\`

## 输出要求

* 仅输出中文译文 JSON，不输出原文或过程说明。
* 标点使用中文全角，省略号统一"……"。

请翻译：

`

// ── 主要导出函数 ─────────────────────────────────────────────────────────────

/**
 * 批量翻译文本列表。
 * 当前仅实现日→中（与后端一致），其他语言组合直接返回原文。
 */
export async function translateBatch(
  texts: string[],
  sourceLang: string,
  targetLang: string,
): Promise<string[]> {
  if (!texts.length) return []

  // 仅支持 日→中 和 英→中
  const isJaZh = sourceLang === 'japan' && targetLang === 'zh'
  const isEnZh = sourceLang === 'en' && targetLang === 'zh'
  if (!isJaZh && !isEnZh) return texts

  const cfg = loadLLMConfig()
  if (!cfg.api_key) throw new Error('请先在设置页配置 API Key')

  const inputData: Record<string, string> = {}
  texts.forEach((t, i) => { inputData[String(i + 1)] = t })

  const promptTemplate = isEnZh ? EN_ZH_PROMPT : MANGA_PROMPT
  const prompt = promptTemplate + JSON.stringify(inputData)

  const baseUrl = cfg.base_url.replace(/\/+$/, '')
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4000,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`LLM API 错误 ${res.status}: ${errText.slice(0, 200)}`)
  }

  const data = await res.json()
  const content: string = data.choices?.[0]?.message?.content?.trim() ?? ''
  return parseTranslationJSON(content, texts)
}

/**
 * 测试 LLM 连接（发送一条 "Hi" 消息）。
 * 成功返回 { model, base_url }，失败抛出 Error。
 */
export async function testLLMConnection(): Promise<{ model: string; base_url: string }> {
  const cfg = loadLLMConfig()
  if (!cfg.api_key) throw new Error('未配置 API Key')

  const baseUrl = cfg.base_url.replace(/\/+$/, '')
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`连接失败 ${res.status}: ${errText.slice(0, 200)}`)
  }

  return { model: cfg.model, base_url: cfg.base_url }
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

function parseTranslationJSON(content: string, fallback: string[]): string[] {
  let cleaned = content.trim()

  // 剥除 markdown 代码块
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7)
    const end = cleaned.lastIndexOf('```')
    if (end !== -1) cleaned = cleaned.slice(0, end)
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3)
    const end = cleaned.lastIndexOf('```')
    if (end !== -1) cleaned = cleaned.slice(0, end)
  }
  cleaned = cleaned.trim()

  try {
    const parsed = JSON.parse(cleaned)
    return fallback.map((orig, i) => String(parsed[String(i + 1)] ?? orig))
  } catch {
    // 尝试提取 JSON 片段
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}') + 1
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(content.slice(start, end))
        return fallback.map((orig, i) => String(parsed[String(i + 1)] ?? orig))
      } catch {}
    }
    return fallback
  }
}
