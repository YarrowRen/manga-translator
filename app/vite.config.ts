import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import https from 'node:https'
import http from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'

// ── 上游代理 Agent（读取 HTTPS_PROXY 环境变量）────────────────────────────────
// 用法：HTTPS_PROXY=http://127.0.0.1:7890 npm run dev
const upstreamProxy = process.env.HTTPS_PROXY || process.env.https_proxy
const proxyAgent = upstreamProxy ? new HttpsProxyAgent(upstreamProxy) : undefined

const EH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

// ── 统一中间件插件 ────────────────────────────────────────────────────────────
// configureServer 不返回函数时，中间件在 Vite 内置 proxy 之前执行，
// 可在此修改 req.headers，proxy 会直接使用修改后的值，避免 proxyReq 时序问题。
const ehentaiPlugin: Plugin = {
  name: 'ehentai',
  configureServer(server) {

    // 1. E-hentai / ExHentai HTML 页面：注入 cookies，清理浏览器特有 headers
    server.middlewares.use((req, _res, next) => {
      const url = req.url ?? ''
      if (url.startsWith('/ehentai-proxy') || url.startsWith('/exhentai-proxy')) {
        const isEx = url.startsWith('/exhentai-proxy')
        const cookie = req.headers['x-ex-cookie'] as string | undefined
        if (cookie) req.headers['cookie'] = cookie
        delete req.headers['x-ex-cookie']
        delete req.headers['origin']
        req.headers['referer']    = isEx ? 'https://exhentai.org/' : 'https://e-hentai.org/'
        req.headers['user-agent'] = EH_UA
      }
      next()
    })

    // 2. 动态图片代理：代理任意 CDN URL（域名不固定，不能用静态 proxy 规则）
    server.middlewares.use('/img-proxy', (req, res) => {
      const urlStr = req.url ?? ''
      const qIdx = urlStr.indexOf('?')
      const qs = qIdx >= 0 ? urlStr.slice(qIdx + 1) : ''
      const targetUrl = new URLSearchParams(qs).get('url')

      if (!targetUrl) { res.statusCode = 400; res.end('Missing url parameter'); return }

      const cookieHeader = (req.headers['x-cookie'] as string) ?? ''
      const reqHeaders: Record<string, string> = {
        'User-Agent': EH_UA,
        'Referer': 'https://e-hentai.org/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      }
      if (cookieHeader) reqHeaders['Cookie'] = cookieHeader

      try {
        const parsed = new URL(targetUrl)
        const isHttps = parsed.protocol === 'https:'
        const options: http.RequestOptions = {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers: reqHeaders,
          ...(proxyAgent ? { agent: proxyAgent } : {}),
        }
        const requester = isHttps ? https : http
        const upstream = requester.request(options, upRes => {
          res.statusCode = upRes.statusCode ?? 200
          const ct = upRes.headers['content-type']
          if (ct) res.setHeader('Content-Type', ct)
          res.setHeader('Cache-Control', 'public, max-age=86400')
          res.setHeader('Access-Control-Allow-Origin', '*')
          upRes.pipe(res)
        })
        upstream.on('error', e => { res.statusCode = 502; res.end(String(e)) })
        upstream.end()
      } catch (e: any) {
        res.statusCode = 400; res.end(String(e))
      }
    })
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ehentaiPlugin],
  optimizeDeps: {
    exclude: ['@techstark/opencv-js'],
  },
  server: {
    port: 5173,
    proxy: {
      // E-hentai / ExHentai HTML 页面（headers 已由中间件修改好）
      '/ehentai-proxy': {
        target: 'https://e-hentai.org',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/ehentai-proxy/, ''),
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      },
      '/exhentai-proxy': {
        target: 'https://exhentai.org',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/exhentai-proxy/, ''),
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      },
      // PaddleOCR 同步接口（境外优化域名，优先使用）
      '/paddleocr-fast-proxy': {
        target: 'https://u954f2b0w5nbi33b.aistudio-app.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/paddleocr-fast-proxy/, ''),
        configure: proxy => {
          proxy.on('proxyReq', proxyReq => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
          })
        },
      },
      // PaddleOCR 异步 job 接口（fallback）
      '/paddleocr-proxy': {
        target: 'https://paddleocr.aistudio-app.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/paddleocr-proxy/, ''),
        configure: proxy => {
          proxy.on('proxyReq', proxyReq => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
          })
        },
      },
      // PaddleOCR 结果文件下载代理
      '/bcebos-proxy': {
        target: 'https://bj.bcebos.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/bcebos-proxy/, ''),
        configure: proxy => {
          proxy.on('proxyReq', proxyReq => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
          })
        },
      },
    },
  },
})
