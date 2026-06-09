// 浏览器 harness：在无头浏览器里复用 @md/core 的完整渲染管线。
// Puppeteer 加载本页面后调用 window.__mdRender(markdown, options)，
// 流程对齐 apps/web 的「渲染 → 应用主题 → 复制(juice 内联)」：
//   1. initRenderer + renderMarkdown + postProcessHtml → 写入 #output
//   2. applyTheme → 注入 #md-theme 主题样式
//   3. 等待 mermaid / plantuml / infographic 异步落地 SVG + MathJax 完成
//   4. 复刻 processClipboardContent：juice 内联 + 微信兼容清理 → 返回字符串
import { applyTheme, initRenderer } from '@md/core'
import { postProcessHtml, renderMarkdown } from '@md/core/utils'
import type { RenderOptions } from '../types'
import { hljsThemes } from './generated/hljs-themes'

declare global {
  interface Window {
    MathJax?: any
    __mdRender: (markdown: string, options: RenderOptions) => Promise<string>
    __mdReady: Promise<void>
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 等待 MathJax 主脚本加载并完成初始化（KaTeX 扩展依赖同步的 tex2svg） */
async function waitForMathJax(timeoutMs = 15000): Promise<void> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (window.MathJax?.tex2svg) {
      if (window.MathJax.startup?.promise) {
        try {
          await window.MathJax.startup.promise
        }
        catch {}
      }
      return
    }
    await sleep(50)
  }
  // 超时也继续：无公式的文档不应被 MathJax 缺失阻塞
}

/** 等待异步图表（mermaid / infographic / plantuml）把占位符替换为真实 SVG */
async function waitForDiagrams(timeoutMs: number): Promise<void> {
  const start = performance.now()
  const isPending = () => {
    const placeholders = Array.from(
      document.querySelectorAll<HTMLElement>(
        `#output .mermaid-diagram, #output .infographic-diagram, #output .plantuml-diagram, #output [data-placeholder]`,
      ),
    )
    return placeholders.some((el) => {
      // 仍是「正在加载…」占位文本且未渲染出子元素 → 未完成
      const loading = /正在加载|加载中/.test(el.textContent || ``)
      const hasGraphic = el.querySelector(`svg, img`) !== null
      return loading && !hasGraphic
    })
  }

  while (performance.now() - start < timeoutMs) {
    if (!isPending()) {
      // 再等一拍，确保 DOM 落定
      await sleep(120)
      if (!isPending())
        return
    }
    await sleep(150)
  }

  // 超时：把仍未渲染的占位符替换为干净提示，避免「正在加载…」被带进最终 HTML
  document
    .querySelectorAll<HTMLElement>(`#output .mermaid-diagram, #output .infographic-diagram, #output .plantuml-diagram`)
    .forEach((el) => {
      if (/正在加载|加载中/.test(el.textContent || ``) && !el.querySelector(`svg, img`))
        el.innerHTML = `<span style="color:#999;font-style:italic;">（图表渲染超时）</span>`
    })
}

// ---- 以下为 apps/web/src/utils/index.ts 浏览器侧逻辑的移植 ----

function getThemeStyles(): string {
  const themeStyle = document.querySelector(`#md-theme`) as HTMLStyleElement | null
  if (!themeStyle || !themeStyle.textContent)
    return ``

  // 导出后的 HTML 不再处于 #output 容器中，需移除作用域前缀
  let cssContent = themeStyle.textContent
  cssContent = cssContent.replace(/#output\s*\{/g, `body {`)
  cssContent = cssContent.replace(/#output\s+/g, ``)
  cssContent = cssContent.replace(/^#output\s*/gm, ``)
  return `<style>${cssContent}</style>`
}

function getStylesToAdd(codeTheme: string): string {
  const themeStyles = getThemeStyles()
  // 代码高亮 CSS 从内置主题表查找（离线，无需联网）
  const hljsCss = hljsThemes[codeTheme] || hljsThemes[`github-dark`] || ``
  const hljsStyles = hljsCss ? `<style>${hljsCss}</style>` : ``
  return [themeStyles, hljsStyles].filter(Boolean).join(``)
}

async function mergeCss(html: string): Promise<string> {
  const { default: juice } = await import(`juice`)
  return juice(html, {
    inlinePseudoElements: true,
    preserveImportant: true,
    resolveCSSVariables: false,
  })
}

function modifyHtmlStructure(htmlString: string): string {
  const tempDiv = document.createElement(`div`)
  tempDiv.innerHTML = htmlString
  // 微信后台兼容：把 li > ul / li > ol 提到 li 后面
  tempDiv.querySelectorAll(`li > ul, li > ol`).forEach((originalItem) => {
    originalItem.parentElement?.insertAdjacentElement(`afterend`, originalItem)
  })
  return tempDiv.innerHTML
}

function createEmptyNode(): HTMLElement {
  const node = document.createElement(`p`)
  node.style.fontSize = `0`
  node.style.lineHeight = `0`
  node.style.margin = `0`
  node.innerHTML = `&nbsp;`
  return node
}

function solveWeChatImage(root: HTMLElement): void {
  const images = root.getElementsByTagName(`img`)
  Array.from(images).forEach((image) => {
    const width = image.getAttribute(`width`)
    const height = image.getAttribute(`height`)
    if (width) {
      image.removeAttribute(`width`)
      image.style.width = /^\d+$/.test(width) ? `${width}px` : width
    }
    if (height) {
      image.removeAttribute(`height`)
      image.style.height = /^\d+$/.test(height) ? `${height}px` : height
    }
  })
}

/** 复刻 processClipboardContent：返回微信可直接粘贴的完全内联 HTML */
async function processClipboardContent(primaryColor: string, codeTheme: string): Promise<string> {
  const outputElement = document.getElementById(`output`)
  if (!outputElement)
    return ``

  const clipboardDiv = outputElement.cloneNode(true) as HTMLElement

  const stylesToAdd = getStylesToAdd(codeTheme)
  if (stylesToAdd)
    clipboardDiv.innerHTML = stylesToAdd + clipboardDiv.innerHTML

  // juice 内联 + 结构调整
  clipboardDiv.innerHTML = modifyHtmlStructure(await mergeCss(clipboardDiv.innerHTML))

  // 移除页面内锚点（微信后台不支持）
  clipboardDiv.querySelectorAll(`a[href^="#"]`).forEach(a => a.removeAttribute(`href`))

  // CSS 变量替换 + mermaid label 清理
  clipboardDiv.innerHTML = clipboardDiv.innerHTML
    .replace(/([^-])top:(.*?)em/g, `$1transform: translateY($2em)`)
    .replace(/hsl\(var\(--foreground\)\)/g, `#3f3f3f`)
    .replace(/var\(--blockquote-background\)/g, `#f7f7f7`)
    .replace(/var\(--md-primary-color\)/g, primaryColor)
    .replace(/--md-primary-color:.+?;/g, ``)
    .replace(/--md-font-family:.+?;/g, ``)
    .replace(/--md-font-size:.+?;/g, ``)
    .replace(
      /<span class="nodeLabel"([^>]*)><p[^>]*>(.*?)<\/p><\/span>/g,
      `<span class="nodeLabel"$1>$2</span>`,
    )
    .replace(
      /<span class="edgeLabel"([^>]*)><p[^>]*>(.*?)<\/p><\/span>/g,
      `<span class="edgeLabel"$1>$2</span>`,
    )

  solveWeChatImage(clipboardDiv)

  // 兼容 SVG 复制的空白节点
  clipboardDiv.insertBefore(createEmptyNode(), clipboardDiv.firstChild)
  clipboardDiv.appendChild(createEmptyNode())

  // 兼容 Mermaid：把 nodeLabel 的 foreignObject 结构压平成 section
  clipboardDiv.querySelectorAll(`.nodeLabel`).forEach((node) => {
    const parent = node.parentElement
    if (!parent)
      return
    const xmlns = parent.getAttribute(`xmlns`)
    const style = parent.getAttribute(`style`)
    if (!xmlns || !style)
      return
    const section = document.createElement(`section`)
    section.setAttribute(`xmlns`, xmlns)
    section.setAttribute(`style`, style)
    section.innerHTML = parent.innerHTML
    const grand = parent.parentElement
    if (!grand)
      return
    grand.innerHTML = ``
    grand.appendChild(section)
  })

  // 修复 mermaid tspan 文本颜色被 stroke 覆盖
  clipboardDiv.innerHTML = clipboardDiv.innerHTML.replace(
    /<tspan([^>]*)>/g,
    `<tspan$1 style="fill: #333333 !important; color: #333333 !important; stroke: none !important;">`,
  )

  // 修复 antv infographic 在 Safari 下 dominant-baseline 文本异常
  clipboardDiv.querySelectorAll(`.infographic-diagram`).forEach((diagram) => {
    diagram.querySelectorAll(`text`).forEach((textElem) => {
      const dominantBaseline = textElem.getAttribute(`dominant-baseline`)
      const variantMap: Record<string, string> = {
        'alphabetic': ``,
        'central': `0.35em`,
        'middle': `0.35em`,
        'hanging': `-0.55em`,
        'ideographic': `0.18em`,
        'text-before-edge': `-0.85em`,
        'text-after-edge': `0.15em`,
      }
      if (dominantBaseline) {
        textElem.removeAttribute(`dominant-baseline`)
        const dy = variantMap[dominantBaseline]
        if (dy)
          textElem.setAttribute(`dy`, dy)
      }
    })
  })

  return clipboardDiv.innerHTML
}

// 在页面加载早期就开始等待 MathJax，render 时再 await，避免重复等待
window.__mdReady = waitForMathJax()

window.__mdRender = async (markdown: string, options: RenderOptions): Promise<string> => {
  await window.__mdReady

  const renderer = initRenderer({
    isMacCodeBlock: options.isMacCodeBlock,
    isShowLineNumber: options.isShowLineNumber,
  })

  renderer.reset({
    citeStatus: options.citeStatus,
    legend: options.legend as any,
    countStatus: options.countStatus,
    isMacCodeBlock: options.isMacCodeBlock,
    isShowLineNumber: options.isShowLineNumber,
    themeMode: options.themeMode as any,
  })

  const { html: baseHtml, readingTime } = renderMarkdown(markdown, renderer)
  const outputHtml = postProcessHtml(baseHtml, readingTime, renderer)

  const outputEl = document.getElementById(`output`)!
  outputEl.innerHTML = outputHtml

  // 给图表容器一个真实尺寸：@antv/infographic 基于 canvas/SVG 渲染，
  // 容器高度为 0 时其 loaded 事件不会触发。这一步必须在扩展的异步
  // findContainer/render 微任务执行前（同一同步块内）完成。
  outputEl.querySelectorAll<HTMLElement>(`.infographic-diagram`).forEach((el) => {
    el.style.minHeight = `360px`
    el.style.minWidth = `600px`
  })

  await applyTheme({
    themeName: options.theme as any,
    customCSS: options.customCSS,
    variables: {
      primaryColor: options.primaryColor,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      isUseIndent: options.isUseIndent,
      isUseJustify: options.isUseJustify,
      headingStyles: options.headingStyles as any,
    },
  })

  // 等待字体就绪，避免图表/公式按 fallback 字体布局
  try {
    await (document as any).fonts?.ready
  }
  catch {}

  await waitForDiagrams(options.diagramTimeout)

  return processClipboardContent(options.primaryColor, options.codeTheme)
}
