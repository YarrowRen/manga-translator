#!/usr/bin/env node
// deploy/proxy-server.cjs
// 生产环境代理服务 — 仅使用 Node.js 内置模块，无需额外依赖
// 处理所有需要 header 操作的代理路由：
//   /paddleocr-proxy/*  →  https://paddleocr.aistudio-app.com
//   /bcebos-proxy/*     →  https://bj.bcebos.com
//   /ehentai-proxy/*    →  https://e-hentai.org   (注入 X-EX-Cookie)
//   /exhentai-proxy/*   →  https://exhentai.org   (注入 X-EX-Cookie)
//   /img-proxy?url=...  →  动态 CDN URL            (注入 X-Cookie)

'use strict'

const http  = require('node:http')
const https = require('node:https')

const PORT   = parseInt(process.env.PROXY_PORT || '3001', 10)
const EH_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// 可选：服务器自身出口代理（ExHentai 无法直连时使用）
// 通过 systemd Environment= 传入：HTTPS_PROXY=http://127.0.0.1:xxxx
let proxyAgent
const upstreamProxy = process.env.HTTPS_PROXY || process.env.https_proxy
if (upstreamProxy) {
  try {
    // 仅在安装了 https-proxy-agent 时才启用
    const { HttpsProxyAgent } = require('https-proxy-agent')
    proxyAgent = new HttpsProxyAgent(upstreamProxy)
    console.log(`[proxy] Using upstream proxy: ${upstreamProxy}`)
  } catch {
    console.warn('[proxy] https-proxy-agent not found, HTTPS_PROXY ignored')
  }
}

const RULES = [
  { prefix: '/paddleocr-fast-proxy', target: 'https://u954f2b0w5nbi33b.aistudio-app.com', stripOrigin: true },
  { prefix: '/paddleocr-proxy',      target: 'https://paddleocr.aistudio-app.com',        stripOrigin: true },
  { prefix: '/bcebos-proxy',         target: 'https://bj.bcebos.com',                     stripOrigin: true },
  { prefix: '/ehentai-proxy',   target: 'https://e-hentai.org',               injectCookie: true, isEx: false },
  { prefix: '/exhentai-proxy',  target: 'https://exhentai.org',               injectCookie: true, isEx: true  },
]

/** 过滤掉不应转发给上游的请求头 */
const DROP_REQ_HEADERS = new Set(['origin', 'referer', 'host', 'x-ex-cookie', 'x-cookie', 'connection', 'keep-alive'])

function forward(req, res, targetUrl, extraHeaders) {
  let parsed
  try { parsed = new URL(targetUrl) } catch (e) {
    res.statusCode = 400; res.end('Invalid target URL'); return
  }

  const isHttps = parsed.protocol === 'https:'

  // 构造转发 headers
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQ_HEADERS.has(k.toLowerCase())) headers[k] = v
  }
  headers['host'] = parsed.hostname
  if (extraHeaders) Object.assign(headers, extraHeaders)

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (isHttps ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   req.method || 'GET',
    headers,
    ...(proxyAgent ? { agent: proxyAgent } : {}),
  }

  const lib = isHttps ? https : http
  const upstream = lib.request(options, (upRes) => {
    res.statusCode = upRes.statusCode || 200
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (k.toLowerCase() === 'transfer-encoding') continue
      try { res.setHeader(k, v) } catch { /* ignore invalid header */ }
    }
    res.setHeader('Access-Control-Allow-Origin', '*')
    upRes.pipe(res)
  })
  upstream.on('error', (e) => {
    console.error('[proxy] upstream error:', e.message)
    if (!res.headersSent) res.statusCode = 502
    res.end(String(e))
  })
  req.pipe(upstream)
}

const server = http.createServer((req, res) => {
  const url = req.url || '/'

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.statusCode = 204
    res.end()
    return
  }

  // /img-proxy?url=<encoded>  动态 CDN URL
  if (url.startsWith('/img-proxy')) {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
    const targetUrl = new URLSearchParams(qs).get('url')
    if (!targetUrl) { res.statusCode = 400; res.end('Missing url parameter'); return }
    const cookieHeader = req.headers['x-cookie'] || ''
    const extra = {
      'User-Agent': EH_UA,
      'Referer':    'https://e-hentai.org/',
      'Accept':     'image/webp,image/apng,image/*,*/*;q=0.8',
    }
    if (cookieHeader) extra['Cookie'] = cookieHeader
    forward(req, res, targetUrl, extra)
    return
  }

  // 静态 prefix 规则
  for (const rule of RULES) {
    if (url.startsWith(rule.prefix)) {
      const path = url.slice(rule.prefix.length) || '/'
      const extra = {}
      if (rule.injectCookie) {
        const cookie = req.headers['x-ex-cookie'] || ''
        if (cookie) extra['Cookie'] = cookie
        extra['Referer']    = rule.isEx ? 'https://exhentai.org/' : 'https://e-hentai.org/'
        extra['User-Agent'] = EH_UA
      }
      forward(req, res, rule.target + path, extra)
      return
    }
  }

  res.statusCode = 404
  res.end('Not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] Listening on 127.0.0.1:${PORT}`)
})
