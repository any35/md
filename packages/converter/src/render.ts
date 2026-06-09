import type { Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import puppeteer from 'puppeteer'
import type { RenderOptions } from './types'

const HARNESS_FILE = fileURLToPath(new URL(`./harness.html`, import.meta.url))
const FONT_DIR = fileURLToPath(new URL(`./fonts`, import.meta.url))

/** 启动一个极简服务器托管单文件 harness（避免 file:// 下 ES module 加载限制） */
function startHarnessServer(): Promise<{ server: Server, port: number }> {
  const html = readFileSync(HARNESS_FILE)
  const server = createServer((req, res) => {
    if ((req.url || `/`).startsWith(`/favicon`)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': `text/html; charset=utf-8` })
    res.end(html)
  })
  return new Promise((resolve) => {
    server.listen(0, `127.0.0.1`, () => {
      const addr = server.address()
      const port = typeof addr === `object` && addr ? addr.port : 0
      resolve({ server, port })
    })
  })
}

/**
 * 在 Linux 上把内置中文字体通过 fontconfig 注册给 Chromium，实现免装系统字体的
 * 离线中文渲染。返回需要附加到浏览器进程的环境变量。
 * macOS / Windows 使用系统字体（自带中文），跳过。
 */
function setupEmbeddedFonts(log: (m: string) => void): Record<string, string> | undefined {
  if (process.platform !== `linux` || process.env.MD2WX_SKIP_FONTS)
    return undefined
  if (!existsSync(FONT_DIR))
    return undefined

  const cacheDir = join(tmpdir(), `md2wx-fontcache`)
  mkdirSync(cacheDir, { recursive: true })
  const confPath = join(cacheDir, `fonts.conf`)
  // 保留系统字体（Latin），并追加内置中文字体目录
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>`
  writeFileSync(confPath, conf)
  log(`已注册内置中文字体（fontconfig）`)
  return { FONTCONFIG_FILE: confPath }
}

export interface DiagramExport {
  /** svg | png | both */
  format: `svg` | `png` | `both`
  /** 输出目录 */
  dir: string
  /** PNG 缩放（deviceScaleFactor），默认 2 */
  scale: number
}

export interface RenderResult {
  html: string
  /** 导出的图表文件路径 */
  diagrams: string[]
}

export interface RenderParams {
  markdown: string
  options: RenderOptions
  /** 无头浏览器可执行文件路径（复用系统 Chrome 以减重） */
  chromePath?: string
  noSandbox?: boolean
  /** 整体导航/渲染超时 */
  timeout: number
  /** 图表单独导出配置 */
  diagramExport?: DiagramExport
  /** 进度日志 */
  log?: (msg: string) => void
}

/** 用无头浏览器渲染 Markdown 为微信内联 HTML，并按需导出图表为图片 */
export async function renderMarkdownToInlineHtml(params: RenderParams): Promise<RenderResult> {
  const { markdown, options, chromePath, noSandbox, timeout, diagramExport, log } = params
  const noop = () => {}
  const info = log || noop

  info(`启动静态服务器…`)
  const { server, port } = await startHarnessServer()

  const launchArgs: string[] = []
  if (noSandbox)
    launchArgs.push(`--no-sandbox`, `--disable-setuid-sandbox`)

  const fontEnv = setupEmbeddedFonts(info)

  info(`启动无头浏览器…`)
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath || process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: launchArgs,
    env: { ...process.env, ...(fontEnv || {}) },
  })

  try {
    const page = await browser.newPage()

    // 严格离线校验：拦截并阻断一切非本地请求（设置 MD2WX_BLOCK_NET=1 时启用）
    if (process.env.MD2WX_BLOCK_NET) {
      await page.setRequestInterception(true)
      page.on(`request`, (r) => {
        const u = r.url()
        if (u.startsWith(`http://127.0.0.1`) || u.startsWith(`data:`) || u.startsWith(`blob:`)) {
          r.continue()
        }
        else {
          info(`[拦截外部请求] ${u}`)
          r.abort()
        }
      })
    }

    await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: diagramExport?.scale ?? 2 })
    const debug = !!process.env.MD2WX_DEBUG
    page.on(`console`, (m) => {
      const t = m.text()
      if (debug || /error|失败/i.test(t))
        info(`[页面:${m.type()}] ${t}`)
    })
    page.on(`pageerror`, (err: Error) => info(`[页面异常] ${err.message}`))
    if (debug) {
      page.on(`requestfailed`, r => info(`[请求失败] ${r.url()} ${r.failure()?.errorText || ``}`))
      page.on(`response`, (r) => {
        if (r.status() >= 400)
          info(`[响应${r.status()}] ${r.url()}`)
      })
    }

    info(`加载 harness 页面…`)
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: `networkidle0`, timeout })

    info(`渲染 Markdown…`)
    const html: string = await page.evaluate(
      (md: string, opts: RenderOptions) => window.__mdRender(md, opts),
      markdown,
      options,
    )

    const diagrams: string[] = []
    if (diagramExport)
      diagrams.push(...await exportDiagrams(page, diagramExport, info))

    return { html, diagrams }
  }
  finally {
    await browser.close()
    server.close()
  }
}

/** 遍历 #output 中的每个图表，导出为 SVG / PNG */
async function exportDiagrams(
  page: import('puppeteer').Page,
  cfg: DiagramExport,
  info: (m: string) => void,
): Promise<string[]> {
  const { mkdir, writeFile } = await import(`node:fs/promises`)
  await mkdir(cfg.dir, { recursive: true })

  const selector = `#output .mermaid-diagram, #output .plantuml-diagram, #output .infographic-diagram`
  const handles = await page.$$(selector)
  info(`发现 ${handles.length} 个图表，开始导出（${cfg.format}）…`)

  const written: string[] = []
  let idx = 0
  for (const handle of handles) {
    idx++
    const kind = await handle.evaluate((el) => {
      if (el.classList.contains(`mermaid-diagram`))
        return `mermaid`
      if (el.classList.contains(`plantuml-diagram`))
        return `plantuml`
      return `infographic`
    })
    const base = `${String(idx).padStart(2, `0`)}-${kind}`

    // 只导出真正渲染出 svg 的图表，跳过加载中/渲染失败的占位符
    const svgHandle = await handle.$(`svg`)
    if (!svgHandle) {
      info(`⚠️  第 ${idx} 个图表（${kind}）未渲染出 SVG，跳过导出`)
      continue
    }

    if (cfg.format === `svg` || cfg.format === `both`) {
      const svg = await svgHandle.evaluate(node => node.outerHTML)
      if (svg) {
        const file = join(cfg.dir, `${base}.svg`)
        await writeFile(file, ensureSvgHeader(svg), `utf-8`)
        written.push(file)
      }
    }

    if (cfg.format === `png` || cfg.format === `both`) {
      const file = join(cfg.dir, `${base}.png`)
      await svgHandle.screenshot({ path: file as `${string}.png`, omitBackground: false })
      written.push(file)
    }
  }
  return written
}

function ensureSvgHeader(svg: string): string {
  if (svg.includes(`xmlns`))
    return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.replace(`<svg`, `<svg xmlns="http://www.w3.org/2000/svg"`)}`
}
