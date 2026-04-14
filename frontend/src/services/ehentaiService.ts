/**
 * E-hentai / ExHentai 画廊服务
 *
 * 请求路径（通过 Vite dev proxy 绕过 CORS + 注入 cookies）：
 *   /ehentai-proxy/*  → https://e-hentai.org/*
 *   /exhentai-proxy/* → https://exhentai.org/*
 *   /img-proxy?url=*  → 任意 CDN 图片 URL（Vite configureServer 中间件）
 *
 * 流程（与 SelfHentai exhentai_utils.py 一致）：
 *   1. 画廊主页  /g/{gid}/{token}/  → 标题 + 总页数 + 缩略图链接列表
 *   2. 图片页面  /s/{hash}/{gid}-{n} → 大图 CDN URL
 *   3. CDN URL  /img-proxy?url=...  → 图片 Blob → File
 */

import { loadEhentaiConfig, buildCookieString } from './ehentaiConfig'

export interface GalleryInfo {
  gid: string
  token: string
  title: string
  totalPages: number
  useEx: boolean   // 最终实际使用的域名
}

// ── URL 解析 ──────────────────────────────────────────────────────────────────

export function parseGalleryUrl(url: string): { gid: string; token: string; isEx: boolean } | null {
  const m = url.match(/(?:e-hentai|exhentai)\.org\/g\/(\d+)\/([a-f0-9]+)/i)
  if (!m) return null
  return { gid: m[1], token: m[2], isEx: url.includes('exhentai.org') }
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

function cookieHeaders(): Record<string, string> {
  const cfg = loadEhentaiConfig()
  const cookie = buildCookieString(cfg)
  return cookie ? { 'X-EX-Cookie': cookie } : {}
}

/** 缩略图页缓存，避免同一画廊重复请求 */
const thumbPageCache = new Map<string, string>()

async function fetchHtml(proxyPath: string): Promise<string> {
  const res = await fetch(proxyPath, { headers: cookieHeaders() })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function fetchGalleryThumbPage(gid: string, token: string, useEx: boolean, page: number): Promise<string> {
  const key = `${useEx ? 'ex' : 'eh'}:${gid}:${token}:${page}`
  if (thumbPageCache.has(key)) return thumbPageCache.get(key)!

  const base = useEx ? '/exhentai-proxy' : '/ehentai-proxy'
  const qs = page > 0 ? `?p=${page}` : ''
  const html = await fetchHtml(`${base}/g/${gid}/${token}/${qs}`)
  thumbPageCache.set(key, html)
  return html
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** 检测 e-hentai 返回的是否是"仅限 ExHentai"内容 */
function isGalleryUnavailable(doc: Document): boolean {
  // 没有标题元素 → 不是正常画廊页
  if (!doc.querySelector('#gn')) return true
  // ExHentai 未登录会返回"sad panda"图片页，#gn 也不存在
  return false
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

/**
 * 获取画廊基本信息：标题、总页数
 * 优先 e-hentai → 失败自动切换 exhentai
 */
export async function fetchGalleryInfo(gid: string, token: string, forceEx = false): Promise<GalleryInfo> {
  const cfg = loadEhentaiConfig()
  const hasCookies = !!(cfg.member_id && cfg.pass_hash)

  let html: string
  let useEx = forceEx

  if (!forceEx) {
    try {
      html = await fetchGalleryThumbPage(gid, token, false, 0)
      if (isGalleryUnavailable(parseHtml(html))) {
        if (!hasCookies) throw new Error('该画廊仅限 ExHentai，请在设置中配置 ExHentai cookies')
        throw new Error('e-hentai 不可用，切换 exhentai')
      }
    } catch (err: any) {
      if (!hasCookies) throw err
      // 回退到 exhentai
      useEx = true
      html = await fetchGalleryThumbPage(gid, token, true, 0)
    }
  } else {
    if (!hasCookies) throw new Error('ExHentai 需要配置 cookies，请在设置页填写')
    html = await fetchGalleryThumbPage(gid, token, true, 0)
  }

  const doc = parseHtml(html)
  if (isGalleryUnavailable(doc)) throw new Error('无法访问该画廊，请检查 cookies 配置')

  const title = doc.querySelector('#gn')?.textContent?.trim() || 'Unknown Gallery'

  // 方式 1：".gpc" 包含 "of N images"
  let totalPages = 0
  const gpcText = doc.querySelector('.gpc')?.textContent ?? ''
  const m1 = gpcText.match(/of (\d+) images/)
  if (m1) totalPages = parseInt(m1[1])

  // 方式 2：画廊详情表格的 "Length" 行
  if (!totalPages) {
    for (const tr of Array.from(doc.querySelectorAll('#gdd tr'))) {
      const label = tr.querySelector('.gdt1')?.textContent ?? ''
      const value = tr.querySelector('.gdt2')?.textContent ?? ''
      if (label.toLowerCase().includes('length')) {
        const m2 = value.match(/(\d+)/)
        if (m2) { totalPages = parseInt(m2[1]); break }
      }
    }
  }

  return { gid, token, title, totalPages, useEx }
}

/**
 * 获取指定页（1-indexed）的 CDN 图片 URL
 * thumbPage = Math.floor((pageNum-1)/20)  每个缩略图页显示 20 张
 */
export async function fetchPageImageUrl(
  gid: string, token: string, pageNum: number, useEx: boolean,
): Promise<string> {
  const thumbPage = Math.floor((pageNum - 1) / 20)
  const thumbIndex = (pageNum - 1) % 20

  const html = await fetchGalleryThumbPage(gid, token, useEx, thumbPage)
  const doc = parseHtml(html)

  const links = doc.querySelectorAll('#gdt a')
  if (thumbIndex >= links.length) throw new Error(`第 ${pageNum} 页缩略图不存在`)

  const imagePageUrl = (links[thumbIndex] as HTMLAnchorElement).href
  if (!imagePageUrl) throw new Error('无法获取图片页面链接')

  // 将图片页面 URL 也通过同一代理请求
  const proxiedImagePageUrl = imagePageUrl.replace(
    useEx ? 'https://exhentai.org' : 'https://e-hentai.org',
    useEx ? '/exhentai-proxy' : '/ehentai-proxy',
  )

  const imgHtml = await fetchHtml(proxiedImagePageUrl)
  const imgDoc = parseHtml(imgHtml)

  const imgSrc = (imgDoc.querySelector('#i3 img') as HTMLImageElement | null)?.src
  if (!imgSrc) throw new Error(`第 ${pageNum} 页大图 URL 未找到`)

  return imgSrc
}

/**
 * 下载 CDN 图片并返回 File 对象，可直接传入 addImages()
 */
export async function fetchImageAsFile(imageUrl: string, filename: string): Promise<File> {
  const cfg = loadEhentaiConfig()
  const cookie = buildCookieString(cfg)

  const res = await fetch(`/img-proxy?url=${encodeURIComponent(imageUrl)}`, {
    headers: cookie ? { 'X-Cookie': cookie } : {},
  })
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`)

  const blob = await res.blob()
  return new File([blob], filename, { type: blob.type || 'image/jpeg' })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * 批量获取多页图片 File，带简单限速
 */
export async function fetchGalleryPages(
  info: GalleryInfo,
  fromPage: number,
  toPage: number,
  onProgress?: (page: number) => void,
): Promise<File[]> {
  const files: File[] = []
  for (let p = fromPage; p <= Math.min(toPage, info.totalPages); p++) {
    try {
      const imgUrl = await fetchPageImageUrl(info.gid, info.token, p, info.useEx)
      const file = await fetchImageAsFile(imgUrl, `${info.gid}-p${String(p).padStart(3, '0')}.jpg`)
      files.push(file)
      onProgress?.(p)
    } catch (e: any) {
      console.warn(`第 ${p} 页加载失败:`, e.message)
      // 创建空 placeholder 占位，让页码保持连续
    }
    if (p < toPage) await sleep(300)  // 限速，避免触发速率限制
  }
  return files
}
