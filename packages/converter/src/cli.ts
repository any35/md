import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { text } from 'node:stream/consumers'
import { Command } from 'commander'
import JSON5 from 'json5'
import { renderMarkdownToInlineHtml } from './render'
import type { RenderOptions } from './types'

// 与 apps/web defaultStyleConfig 对齐的默认值（避免运行时依赖 @md/shared）
const DEFAULTS = {
  theme: `default`,
  primaryColor: `#0F4C81`,
  fontFamily: `-apple-system-font,BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB , Microsoft YaHei UI , Microsoft YaHei ,Arial,sans-serif`,
  fontSize: `16px`,
  legend: `alt`,
  codeTheme: `github-dark`,
}

const HEADING_LEVELS = [`h1`, `h2`, `h3`, `h4`, `h5`, `h6`]
const HEADING_STYLES = [`default`, `color-only`, `border-bottom`, `border-left`, `custom`]

const log = (m: string) => process.stderr.write(`${m}\n`)

/** 解析 `--heading-style h2:border-left,h3:color-only`（可重复） */
function collectHeadingStyle(val: string, acc: Record<string, string>): Record<string, string> {
  for (const pair of val.split(`,`)) {
    const [level, style] = pair.split(`:`).map(s => s.trim())
    if (!level || !style)
      continue
    if (!HEADING_LEVELS.includes(level)) {
      log(`⚠️  忽略未知标题级别：${level}（可选 h1~h6）`)
      continue
    }
    if (!HEADING_STYLES.includes(style)) {
      log(`⚠️  忽略未知标题样式：${style}（可选 ${HEADING_STYLES.join(`/`)}）`)
      continue
    }
    acc[level] = style
  }
  return acc
}

function buildFullDocument(title: string, innerHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body>
  <div style="max-width: 750px; margin: 0 auto; padding: 20px;">
${innerHtml}
  </div>
</body>
</html>
`
}

async function main() {
  const program = new Command()
  program
    .name(`md2wx`)
    .description(`将 Markdown 渲染为微信公众号 inline-style HTML（无头浏览器全保真）`)
    .argument(`<input.md>`, `输入 Markdown 文件；传 - 从 stdin 读取`)
    .option(`-c, --config <file>`, `JSON5 配置文件（命令行参数优先级高于配置文件）`)
    .option(`-o, --output <file>`, `输出 HTML 文件（默认同名 .html）；传 - 输出到 stdout 并静默日志（stdin 输入时默认 stdout）`)
    .option(`--theme <name>`, `主题：default | grace | simple`, DEFAULTS.theme)
    .option(`--primary-color <hex>`, `主题色`, DEFAULTS.primaryColor)
    .option(`--font-family <css>`, `字体族`, DEFAULTS.fontFamily)
    .option(`--font-size <px>`, `字号，如 16px`, DEFAULTS.fontSize)
    .option(`--legend <mode>`, `图注来源：alt|title|title-alt|alt-title|filename|none`, DEFAULTS.legend)
    .option(`--code-theme <name>`, `highlight.js 主题名`, DEFAULTS.codeTheme)
    .option(
      `--heading-style <level:style...>`,
      `按级标题样式，如 h2:border-left（可重复或逗号分隔；样式 ${HEADING_STYLES.join(`/`)}）`,
      collectHeadingStyle,
      {},
    )
    .option(`--indent`, `段落首行缩进`)
    .option(`--justify`, `两端对齐`)
    .option(`--cite`, `显示微信外链引用脚注`)
    .option(`--no-mac-code-block`, `关闭 Mac 风格代码块`)
    .option(`--line-number`, `代码块显示行号`)
    .option(`--count`, `显示字数 / 阅读时间`)
    .option(`--dark`, `暗色模式渲染`)
    .option(`--custom-css <file>`, `自定义 CSS 文件（作用于 #output）`)
    .option(`--full-document`, `输出独立 HTML 文档（默认仅输出可粘贴的内联片段）`)
    .option(`--export-diagrams <dir>`, `把每个图表单独导出为图片到该目录`)
    .option(`--diagram-format <fmt>`, `图表导出格式：svg | png | both`, `svg`)
    .option(`--diagram-scale <n>`, `PNG 缩放倍数`, `2`)
    .option(`--chrome <path>`, `指定 Chrome/Chromium 可执行文件路径`)
    .option(`--no-sandbox`, `以 --no-sandbox 启动浏览器（容器/CI 常用）`)
    .option(`--timeout <ms>`, `渲染超时（毫秒）`, `60000`)
    .action(async (input: string, opts: Record<string, any>, command: Command) => {
      // 加载 JSON5 配置文件
      let config: Record<string, any> = {}
      let configDir = process.cwd()
      if (opts.config) {
        const configPath = resolve(opts.config)
        configDir = dirname(configPath)
        try {
          config = JSON5.parse(await readFile(configPath, `utf-8`))
        }
        catch (err) {
          log(`❌ 读取配置文件失败：${configPath}\n   ${(err as Error).message}`)
          process.exit(1)
        }
      }

      // 取值优先级：命令行显式参数 > 配置文件 > 内置默认（commander 默认）
      const eff = (key: string): { value: any, fromConfig: boolean } => {
        if (command.getOptionValueSource(key) === `cli`)
          return { value: opts[key], fromConfig: false }
        if (config[key] !== undefined)
          return { value: config[key], fromConfig: true }
        return { value: opts[key], fromConfig: false }
      }
      const val = (key: string) => eff(key).value
      // 路径类取值：来自配置文件的相对路径相对配置文件目录解析，否则相对 cwd
      const resolvePath = (key: string): string | undefined => {
        const { value, fromConfig } = eff(key)
        if (!value)
          return undefined
        if (isAbsolute(value))
          return value
        return resolve(fromConfig ? configDir : process.cwd(), value)
      }

      // 管道模式：输入 - 读 stdin；输出 - 写 stdout（stdin 输入且未指定输出时默认 stdout）。
      // stdout 模式下静默所有进度日志，保证输出可直接管道消费。
      const fromStdin = input === `-`
      const outRaw = eff(`output`).value
      const toStdout = outRaw === `-` || (fromStdin && !outRaw)
      const quiet = toStdout && !process.env.MD2WX_DEBUG
      const say = quiet ? () => {} : log

      let markdown: string
      let title: string
      if (fromStdin) {
        markdown = await text(process.stdin)
        title = `untitled`
        if (!markdown.trim()) {
          log(`❌ stdin 没有内容`)
          process.exit(1)
        }
      }
      else {
        const inputPath = resolve(input)
        markdown = await readFile(inputPath, `utf-8`).catch(() => {
          log(`❌ 无法读取输入文件：${inputPath}`)
          process.exit(1)
        }) as string
        title = basename(inputPath, extname(inputPath))
      }

      const customCssPath = resolvePath(`customCss`)
      const customCSS = customCssPath
        ? await readFile(customCssPath, `utf-8`).catch(() => {
            say(`⚠️  自定义 CSS 读取失败：${customCssPath}`)
            return ``
          })
        : ``

      // 标题样式：配置文件与命令行按级合并（命令行同级覆盖配置）
      const headingStyles: Record<string, string> = {
        ...(config.headingStyles || {}),
        ...(opts.headingStyle || {}),
      }

      const timeout = Number(val(`timeout`)) || 60000
      const macCodeBlock = val(`macCodeBlock`)

      const options: RenderOptions = {
        theme: val(`theme`),
        primaryColor: val(`primaryColor`),
        fontFamily: val(`fontFamily`),
        fontSize: val(`fontSize`),
        isUseIndent: !!val(`indent`),
        isUseJustify: !!val(`justify`),
        headingStyles,
        citeStatus: !!val(`cite`),
        legend: val(`legend`),
        countStatus: !!val(`count`),
        isMacCodeBlock: macCodeBlock !== false,
        isShowLineNumber: !!val(`lineNumber`),
        themeMode: val(`dark`) ? `dark` : `light`,
        customCSS,
        codeTheme: val(`codeTheme`),
        diagramTimeout: Math.max(5000, timeout - 5000),
      }

      const exportDir = resolvePath(`exportDiagrams`)
      const diagramExport = exportDir
        ? {
            dir: exportDir,
            format: (val(`diagramFormat`) as `svg` | `png` | `both`),
            scale: Number(val(`diagramScale`)) || 2,
          }
        : undefined

      const { html, diagrams } = await renderMarkdownToInlineHtml({
        markdown,
        options,
        chromePath: val(`chrome`),
        noSandbox: val(`sandbox`) === false,
        timeout,
        diagramExport,
        log: say,
      })

      const finalHtml = val(`fullDocument`) ? buildFullDocument(title, html) : html

      if (toStdout) {
        process.stdout.write(finalHtml)
      }
      else {
        const outPath = resolvePath(`output`) || resolve(`${title}.html`)
        await writeFile(outPath, finalHtml, `utf-8`)
        say(`✅ 已输出：${outPath}`)
      }
      if (diagrams.length)
        say(`✅ 已导出 ${diagrams.length} 个图表到：${diagramExport!.dir}`)
    })

  await program.parseAsync(process.argv)
}

main().catch((err) => {
  process.stderr.write(`❌ ${err?.stack || err}\n`)
  process.exit(1)
})
