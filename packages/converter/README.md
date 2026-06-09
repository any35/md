# @md/converter — Markdown → 微信公众号 inline-style HTML CLI

把 Markdown 渲染成**微信公众号那样 CSS 完全内联（inline style）的 HTML**，可直接粘贴到公众号后台。

复用 [doocs/md](https://md.doocs.org) 的 Web 渲染引擎（`@md/core`），并用**无头浏览器（Puppeteer）**在真实 DOM 中渲染，因此与网页端「复制」效果 100% 一致：

- ✅ **Mermaid 全类型**：流程图、时序图、类图、状态图、ER、甘特、饼图、柱状图、思维导图、架构图等
- ✅ **KaTeX 数学公式**（行内 `$...$` 与块级 `$$...$$`）
- ✅ **PlantUML**（经 PlantUML 服务器渲染为 SVG）
- ✅ **Infographic 信息图**（`@antv/infographic`）
- ✅ **代码高亮**（highlight.js）
- ✅ 主题样式（default / grace / simple）、主题色、字体、字号、标题样式等
- ✅ 把每个图表**单独导出为图片**（SVG / PNG）

> 不包含图床、AI 助手等与转换无关的功能。

## 完全离线

转换过程**不联网**：MathJax、代码高亮主题、渲染引擎全部内联进单文件 `dist/harness.html`；
中文字体（Noto Sans CJK）随包内置，运行时自动通过 fontconfig 注册给 Chromium（Linux），
无需 `apt install fonts-*`。运行时**唯一**的 npm 依赖是 `puppeteer`（提供 Chromium）。

构建产物：

| 文件 | 说明 |
| --- | --- |
| `dist/cli.js` | CLI 入口（已内联 commander 等，~100KB） |
| `dist/harness.html` | 单文件渲染页（内联 @md/core + mermaid + katex + MathJax + 代码高亮，~10MB） |
| `dist/fonts/` | 内置中文字体（~19MB） |

## 安装与构建

```bash
pnpm install
pnpm --filter @md/converter build   # 生成单文件 harness + CLI
```

运行时只需要 Chromium：由 `puppeteer` 自动下载，或用系统 Chrome（`--chrome` / `PUPPETEER_EXECUTABLE_PATH`）。
Linux 容器仍需 Chromium 自身的系统库（见下方 Docker 示例），但**不再需要装字体，也不需要联网**。

## 用法

```bash
# 基本用法：输出可粘贴微信的内联 HTML 片段
node dist/cli.js article.md -o article.html

# 指定主题与主题色
node dist/cli.js article.md -o out.html --theme grace --primary-color "#6B8CFF"

# 把每个图表单独导出为图片（SVG + PNG）
node dist/cli.js article.md -o out.html --export-diagrams ./diagrams --diagram-format both

# 容器 / CI 环境
node dist/cli.js article.md -o out.html --no-sandbox

# 管道模式：stdin 读入、stdout 输出（此模式自动静默所有日志，stdout 为纯 HTML）
cat article.md | node dist/cli.js - --no-sandbox > out.html
node dist/cli.js article.md -o - --no-sandbox | pbcopy
```

### 常用参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `<input.md>` | 输入 Markdown 文件（必填）；传 `-` 从 stdin 读取 | — |
| `-c, --config <file>` | JSON5 配置文件（命令行参数优先级更高） | — |
| `-o, --output <file>` | 输出 HTML 文件；传 `-` 写到 stdout 并静默日志 | `<输入名>.html`（stdin 输入时为 stdout） |
| `--theme <name>` | 主题：`default` / `grace` / `simple` | `default` |
| `--primary-color <hex>` | 主题色 | `#0F4C81` |
| `--font-size <px>` | 字号 | `16px` |
| `--font-family <css>` | 字体族 | 无衬线 |
| `--code-theme <name>` | highlight.js 主题名 | `github-dark` |
| `--heading-style <level:style...>` | 按级标题样式，如 `h2:border-left`（可重复/逗号分隔；样式 `default`/`color-only`/`border-bottom`/`border-left`） | 全部 default |
| `--legend <mode>` | 图注来源：`alt`/`title`/`title-alt`/`alt-title`/`filename`/`none` | `alt` |
| `--indent` / `--justify` | 段落首行缩进 / 两端对齐 | 关 |
| `--cite` | 显示微信外链引用脚注 | 关 |
| `--no-mac-code-block` | 关闭 Mac 风格代码块 | 开 |
| `--line-number` | 代码块显示行号 | 关 |
| `--count` | 显示字数 / 阅读时间 | 关 |
| `--dark` | 暗色模式渲染 | 关 |
| `--custom-css <file>` | 自定义 CSS 文件（作用于 `#output`） | — |
| `--full-document` | 输出独立 HTML 文档（默认仅输出内联片段） | 关 |
| `--export-diagrams <dir>` | 把每个图表单独导出到该目录 | — |
| `--diagram-format <fmt>` | 图表导出格式：`svg` / `png` / `both` | `svg` |
| `--diagram-scale <n>` | PNG 缩放倍数 | `2` |
| `--chrome <path>` | 指定 Chrome/Chromium 可执行文件路径 | — |
| `--no-sandbox` | 以 `--no-sandbox` 启动浏览器 | — |
| `--timeout <ms>` | 渲染超时 | `60000` |

### 配置文件（JSON5）

用 `-c, --config <file>` 加载 JSON5 配置（支持注释、尾逗号、单引号），免去每次敲一长串参数。
**取值优先级：命令行显式参数 > 配置文件 > 内置默认**。配置项用驼峰命名（与参数一一对应）：

```json5
{
  // 主题与配色
  theme: 'grace',
  primaryColor: '#009874',   // 翡翠绿
  fontSize: '17px',
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  codeTheme: 'atom-one-dark',
  legend: 'title-alt',

  // 开关
  cite: true,
  lineNumber: true,
  macCodeBlock: false,        // 对应 --no-mac-code-block
  indent: false,
  justify: true,
  dark: false,

  // 按级标题样式：default | color-only | border-bottom | border-left
  headingStyles: {
    h2: 'border-left',
    h3: 'color-only',
  },

  // 其他
  customCss: './my.css',      // 相对路径相对“配置文件所在目录”解析
  diagramFormat: 'both',
}
```

用法：`node dist/cli.js article.md -c md2wx.config.json5 -o out.html --no-sandbox`
仓库内提供 **`md2wx.config.json5`** —— 一份注释完整、列出所有参数/可选值/默认值的默认配置，复制改改即可用。

环境变量：
- `MD2WX_DEBUG=1` — 打印页面控制台与网络错误
- `MD2WX_BLOCK_NET=1` — 严格离线模式，拦截一切非本地请求（用于校验离线）
- `MD2WX_SKIP_FONTS=1` — 跳过内置字体注册（改用系统字体）
- `PUPPETEER_EXECUTABLE_PATH` — 指定 Chromium 路径

## 工作原理

```
md 文件 ─▶ 读取 + 解析参数 ─▶ 启动本地静态服务托管 harness
       ─▶ Puppeteer 打开 harness（注入 MathJax）
            · initRenderer + renderMarkdown + postProcessHtml → 写入 #output
            · applyTheme → 注入主题样式
            · 等待 mermaid / plantuml / infographic 异步落地 SVG
            · juice 内联 + 微信兼容清理（复刻 processClipboardContent）
       ─▶ 写出内联 HTML（可选：遍历图表导出 SVG/PNG）
```

唯一的例外是 **PlantUML**：它把图表代码发往 PlantUML 服务器渲染，需要联网（或自建 PlantUML 服务）。
其余功能（Mermaid / KaTeX / Infographic / 代码高亮 / 中文）均完全离线。

## Docker（推荐的离线部署）

```dockerfile
FROM node:22-slim
# 仅需 Chromium 的系统库（不需要字体，已内置）
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libatspi2.0-0t64 \
      libglib2.0-0t64 libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dist ./dist
COPY package.json ./
RUN npm install puppeteer        # 下载 Chromium；之后运行完全离线
ENTRYPOINT ["node", "dist/cli.js"]
```
