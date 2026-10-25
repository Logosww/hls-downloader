# hls-downloader 品牌规范

正式标志为 **「斜切汇流」H，27° / 3.2**。H 对应项目名称；斜向留白表达 HLS 分片与流的连接。品牌名称统一写作 `hls-downloader`，API 标识符 `HlsDownloader` 和 npm 包名保持各自原有写法。

![斜切汇流 H](docs/public/brand/logo-deep.svg)

## 标志几何

- 画布：32 × 32；H 外轮廓横向范围 4–28、纵向范围 3–29。
- 左右竖笔画宽度均为 7；横笔画位于 y=13–19，厚度为 6。
- 切口经过 (16, 16)，向右上方倾斜，与水平线夹角 **27°**。
- 切口宽度 **3.2**，沿切口的垂直方向测量，不是垂直屏幕方向的高度。
- 切口中心线：`y = 16 - tan(27°) × (x - 16)`；两侧边界沿法线各偏移 1.6。
- 发布资源为两个闭合实心路径，无蒙版、描边、外部字体或外部资源依赖；坐标保留四位小数。

几何与品牌色的唯一数据源是 [`docs/lib/brand.json`](docs/lib/brand.json)。React 标志与静态资源共用该路径。Web 示例读取脚本生成的 `packages/app/web/lib/brand.generated.json` 镜像，不要手工修改镜像。禁止重新描摹、旋转、拉伸、改变切口、添加渐变或阴影。

## 品牌色

| 颜色       | HEX       | 使用方式                                 |
| ---------- | --------- | ---------------------------------------- |
| 青绿 Mint  | `#22D3B6` | 深色背景上的标志、链接与主按钮           |
| 深青 Deep  | `#087F72` | 浅色背景上的标志、链接与主按钮           |
| 墨色 Ink   | `#0B1F24` | 浅色主题正文、深色主题背景、favicon 底板 |
| 浅底 Paper | `#F4FAF8` | 浅色页面背景、深色主题正文               |
| 白 White   | `#FFFFFF` | 浅色卡片、深青按钮上的文字、反白标志     |

青绿和深青属于同一套主题配对，不随页面任意切换。浅底避免用亮青绿写小字；深青按钮搭配白字，青绿按钮搭配墨色字。品牌色不代替错误、警告等语义色，状态应同时有文字或图标。

文档站样式位于 [`docs/app/global.css`](docs/app/global.css)，Web 示例样式位于 [`packages/app/web/app/global.css`](packages/app/web/app/global.css)。两端的 primary、accent、ring、背景与 sidebar token 保持一致，Fumadocs 与 shadcn 组件使用这些语义色。修改品牌色时，同时更新这两处样式、数据源、本表和 README 徽章颜色，再重新生成资源。

## 字标与留白

- 文档站与 Web 示例字标使用 **Inter 600**，小写 `hls-downloader`，不改变连字符。
- 字标由真实文本排版；正式图形资源不包含文字，也不依赖用户机器上的字体。
- 导航标志 24 × 24 CSS px，与字标间隔 8px；文档站与 Web 示例首页独立标志 80 × 80 CSS px。README 标志同为 80px，字标使用宿主页面字体。
- 独立标志周围至少保留 4 个网格单位的净空（按显示尺寸等比缩放）。32 × 32 SVG 自带边缘留白，布局时仍须保证净空。
- 常规独立标志建议至少 24px；小于该尺寸优先使用专门输出的 favicon。装饰性的标志与完整字标并排时使用 `aria-hidden`；独立的品牌链接必须提供可访问名称。
- 移动端保留完整名称，允许导航项目换行或折叠，不能挤压、拉伸标志。

## 正式资源

正式资源提交在 [`docs/public/brand/`](docs/public/brand/)，同时由脚本同步到 [`packages/app/web/public/brand/`](packages/app/web/public/brand/)。Web 示例使用本地资源，可独立构建和部署；README 通过 `<picture>` 直接引用文档站资源，深色背景使用 Mint、浅色背景和默认回退使用 Deep。徽章统一使用 Ink 标签底色与 Deep 内容底色。

| 资源                                                   | 用途                                          |
| ------------------------------------------------------ | --------------------------------------------- |
| `logo-deep.svg` / `logo-mint.svg`                      | 透明底主标志，分别用于浅底 / 深底             |
| `logo-ink.svg` / `logo-black.svg` / `logo-white.svg`   | 单色、印刷与反白                              |
| `logo-{deep,mint,ink,black,white}-512.png`             | 512px 透明底栅格版本                          |
| `favicon.svg`                                          | 墨色圆角底板 + 青绿 H，适用于深浅色浏览器标签 |
| `favicon-16.png` / `favicon-32.png` / `favicon-48.png` | 对应像素尺寸的 PNG；不从 16px 放大使用        |
| [`docs/public/favicon.ico`](docs/public/favicon.ico)   | 内含 16、32、48px 三个图像的兼容图标          |
| `apple-touch-icon.png`                                 | 180px 全不透明方形背景，由系统处理圆角        |
| `icon-192.png` / `icon-512.png`                        | 应用图标与未来 manifest 集成的预备资源        |

Favicon 保留同一 27° / 3.2 几何，标志使用 `translate(2 2) scale(.875)` 放入 32px 墨色底板；圆角半径为 6。16px 成品的切口法向宽度约为 **1.4px**。不要把独立标志铺满底板，也不要把图标重新导出为有损格式。

## 生成与验证

安装项目依赖后，从根目录执行：

```sh
pnpm --filter @hls-downloader/docs brand:generate
```

脚本为 [`docs/scripts/generate-brand-assets.mjs`](docs/scripts/generate-brand-assets.mjs)，复用当前 Next.js 安装的 Sharp 栅格化依赖。脚本重新输出 SVG、PNG、Apple 图标和多尺寸 ICO，同时同步 Web 示例的资源和品牌数据镜像；两端生成结果应一同提交。在 Web 工作区运行 `brand:generate` 也会调用同一脚本。若后续 Next.js 不再提供 Sharp，需在文档工作区显式添加相应依赖。

验证要点：README 图片引用、两端静态资源一致性、文档站和 Web 示例的浅色与深色首页、导航、移动端完整字标、实际尺寸 16/32px favicon、图标 URL 返回图像而非本地化 HTML。`/brand/` 和 `/favicon.ico` 必须跳过 locale middleware；中英文页面共享同一套绝对路径图标。页面 metadata 统一声明 SVG、PNG、ICO 和 Apple 图标，Open Graph 使用同一 H 标志与青绿色。

品牌与文档站视觉变化不属于已发布库的 API 或行为变更，不写入库的 changelog。

## 文档站 Hero：分片汇流

首页以「让每一段流，完整抵达」为主张。React Bits Threads 直接作为整个 Hero 的背景，延续标志的 27° 方向，表达流与分片的连接。前景集中展示产品说明、快速开始、在线演示和安装命令。

- 背景与页面使用同一主题底色，流线随主题采用 Deep / Mint 配对。无独立卡片、边框、底板或文件流程面板；流线在首屏上下边缘自然淡出。
- 主标题使用实色与稳定排版；文字一侧通过背景色渐变降低动效对比，右侧保留更完整的流线。移动端降低背景强度，不额外占用布局高度。
- 动画提供暂停按钮，尊重 `prefers-reduced-motion`；离开视口或页面隐藏时停止连续渲染。WebGL 不可用时保留静态流线，正文和入口不受影响。
- 中英文共用结构。主文案与入口保持服务端渲染，Threads 独立延迟加载，不新增动画运行时依赖。
- 组件来自 [React Bits Threads](https://reactbits.dev/c/backgrounds/threads)，配套源码及授权声明保留在 `docs/components/react-bits/`，仅用于文档站。

### 首屏交互光效

Hero 的「快速开始」「在线演示」使用 React Bits Specular Button，保留原生链接语义与键盘焦点，边缘高光随指针靠近而增强。主按钮继续采用主题 primary 配色，次按钮采用 card 底色；默认不自动旋转高光。

底部四张功能卡片使用 React Bits Spotlight Card，以主题 primary 形成柔和聚光与边缘亮光，桌面使用两列布局，手机使用单列，保留原有文字与圆角。卡片仅展示信息，不增加无意义的点击或 Tab 停靠。减少动态效果偏好下关闭指针追随，离屏与后台停止渲染；源码与授权声明归入 `docs/components/react-bits/`。
