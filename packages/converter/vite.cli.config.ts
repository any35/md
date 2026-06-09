import { defineConfig } from 'vite'

// 用 Vite 的 SSR 模式打包 Node 侧 CLI。
// 把 commander 打进产物（运行时无需安装）；puppeteer 与 node 内置保持 external。
export default defineConfig({
  ssr: {
    noExternal: [`commander`, `json5`],
    external: [`puppeteer`],
  },
  build: {
    ssr: `src/cli.ts`,
    outDir: `dist`,
    emptyOutDir: false,
    target: `node22`,
    minify: false,
    rollupOptions: {
      external: [`puppeteer`, /^node:/],
      output: {
        entryFileNames: `cli.js`,
        format: `esm`,
        banner: `#!/usr/bin/env node`,
      },
    },
  },
})
