import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * 开发时渲染层跑在 Vite dev server 上，必须放开 `ws:` 与 `http://localhost:*`，
 * 否则热更新连不上。打包出来的版本只从本地文件加载，没有服务器也没有热更新，
 * 这里在构建时把这两个来源去掉，收紧成「只允许自己」——也就是完全不联网。
 */
function tightenCspInBuild() {
  const LOOSE = "connect-src 'self' ws: http://localhost:*"
  const TIGHT = "connect-src 'self'"
  return {
    name: 'jw-tighten-csp',
    transformIndexHtml(html: string, ctx: { server?: unknown }) {
      if (ctx.server) return html
      return html.replace(LOOSE, TIGHT)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tightenCspInBuild()]
  }
})
