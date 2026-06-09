// 渲染选项：从 CLI 参数映射而来，序列化后传入浏览器 harness。
// 字段语义与 apps/web 的 theme store / render store 一一对应。
export interface RenderOptions {
  /** 主题名：default | grace | simple */
  theme: string
  /** 主题色，如 #0F4C81 */
  primaryColor: string
  /** 字体族（CSS font-family 值） */
  fontFamily: string
  /** 字号，如 16px */
  fontSize: string
  /** 段落首行缩进 */
  isUseIndent: boolean
  /** 两端对齐 */
  isUseJustify: boolean
  /** 各级标题样式覆盖，如 { h1: 'border-bottom' } */
  headingStyles: Record<string, string>
  /** 是否显示微信外链引用脚注 */
  citeStatus: boolean
  /** 图注来源：alt | title | title-alt | alt-title | filename | none */
  legend: string
  /** 是否显示字数 / 阅读时间 */
  countStatus: boolean
  /** Mac 风格代码块（红黄绿圆点） */
  isMacCodeBlock: boolean
  /** 代码块显示行号 */
  isShowLineNumber: boolean
  /** 明暗模式：light | dark */
  themeMode: string
  /** 用户自定义 CSS（作用于 #output 作用域） */
  customCSS: string
  /** highlight.js 主题名（从内置主题表查找，离线无需联网） */
  codeTheme: string
  /** 异步图表渲染超时（毫秒） */
  diagramTimeout: number
}
