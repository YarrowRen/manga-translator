/**
 * ExHentai cookies 配置 — 存取 localStorage
 * member_id + pass_hash 必须；igneous 是 ExHentai 专用的额外 cookie
 */

export interface EhentaiConfig {
  member_id: string
  pass_hash: string
  igneous: string   // ExHentai 专用，e-hentai 可为空
}

const STORAGE_KEY = 'manga_trans_ehentai_config'

const DEFAULT_CONFIG: EhentaiConfig = {
  member_id: '',
  pass_hash: '',
  igneous: '',
}

export function loadEhentaiConfig(): EhentaiConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) }
  } catch {}
  return { ...DEFAULT_CONFIG }
}

export function saveEhentaiConfig(cfg: EhentaiConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

export function buildCookieString(cfg: EhentaiConfig): string {
  if (!cfg.member_id || !cfg.pass_hash) return ''
  let s = `ipb_member_id=${cfg.member_id}; ipb_pass_hash=${cfg.pass_hash}`
  if (cfg.igneous) s += `; igneous=${cfg.igneous}`
  return s
}
