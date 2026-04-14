import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // opencv-js 含 WASM，不能被 Vite pre-bundle，必须排除
    exclude: ['@techstark/opencv-js'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5002',
        changeOrigin: true,
      },
      // PaddleOCR 官方云 API 代理（绕过浏览器 CORS 及来源限制）
      '/paddleocr-proxy': {
        target: 'https://paddleocr.aistudio-app.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/paddleocr-proxy/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
          })
        },
      },
      // PaddleOCR 结果文件下载代理（存储在百度云 bj.bcebos.com）
      '/bcebos-proxy': {
        target: 'https://bj.bcebos.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bcebos-proxy/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
          })
        },
      },
    },
  },
})
