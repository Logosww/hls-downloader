# 快速开始

## 安装

**方式一：聚合包 `@logosw/hls-downloader`（推荐）**

一次安装即可使用与 `@hls-downloader/*` 相同的 API，子路径与独立子包一一对应：

```bash
pnpm add @logosw/hls-downloader
```

**方式二：按需安装子包**（减小依赖面或只引用部分能力时）：

```bash
pnpm add @hls-downloader/core @hls-downloader/shared
pnpm add @hls-downloader/adapters
```

`@logosw/hls-downloader` 依赖 `@hls-downloader/core`、`@hls-downloader/shared`、`@hls-downloader/adapters`；`@hls-downloader/core` 已依赖 `@hls-downloader/shared`。使用适配器时均需能解析到 `@hls-downloader/adapters` 中的 browser/node 实现。

**运行环境**：Node.js **≥ 20**。Node 适配器在 Node 下会加载**原生 `.node` 模块**，需使用与你平台、Node ABI 匹配的发布产物；若在浏览器打包，请只打包 **browser** 子路径，不要把 Node 原生模块打进前端。

::: info 默认下载路径（Transmux）
**普通 `download()` 不会加载 FFmpeg。** 分片经轻量 transmux/remux 合并并保留源编码。仅在需要 FFmpeg 合并/转码时，于 `download()` 传入 `transcode`（或设置 `globalOptions.transcode`）。各适配器的 FFmpeg 触发条件见[适配器](/zh/guide/adapters)。
:::

## 基本用法

```ts
import { HlsDownloader } from '@hls-downloader/core'
import { HlsDownloaderEvent } from '@hls-downloader/shared'
import { BrowserAdapter } from '@hls-downloader/adapters/browser'

const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  options: {
    download: { headers: { Authorization: 'Bearer ...' } },
  },
  onEvent: (event, progress) => {
    if (
      event === HlsDownloaderEvent.DOWNLOADING_SEGMENTS ||
      event === HlsDownloaderEvent.STITCHING_SEGMENTS
    ) {
      console.log(progress?.completed, '/', progress?.total)
    }
  },
})

// init() 为轻量初始化，不加载 FFmpeg
await downloader.init()

// 仅解析 playlist — 不下载分片，不加载 FFmpeg
const parsed = await downloader.parseHls({
  url: 'https://example.com/master.m3u8',
  headers: { Authorization: 'Bearer ...' },
})

// 默认下载 — 仅 transmux，不加载 FFmpeg
const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  headers: {},
  filename: 'output',
})

// 显式转码 — 会加载 FFmpeg（详见适配器文档）
// await downloader.download({ url: '...', transcode: { preset: 'h264' } })

if (result) {
  console.log(result.totalSegments)
}

// 使用 AbortController 协作式取消 — 两种适配器均支持
const controller = new AbortController()
setTimeout(() => controller.abort(), 5000) // 例如用户点击了取消
try {
  await downloader.download({
    url: 'https://example.com/stream.m3u8',
    filename: 'output',
    signal: controller.signal,
  })
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('下载已中止')
  } else {
    throw err
  }
}

// 尝试从流中取封面图 URL
const poster = await downloader.getPosterUrl({ url: '...' })
```

也可以使用聚合包导入：

```ts
import { HlsDownloader, HlsDownloaderEvent, BrowserAdapter } from '@logosw/hls-downloader'
```

Node.js 侧将 `BrowserAdapter` 换成 `NodeAdapter` 即可：

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node'

const downloader = new HlsDownloader({
  adapter: NodeAdapter,
  onEvent: (event, progress) => {
    // ...
  },
})
await downloader.init()
```

## 包与子路径

| 包 / 入口 | 用途 |
|-----------|------|
| `@logosw/hls-downloader` | 聚合入口：默认导出 `HlsDownloader`，并再导出 `shared`、Browser/Node 适配器等 |
| `@logosw/hls-downloader/core` | 同 `@hls-downloader/core` |
| `@logosw/hls-downloader/shared` | 同 `@hls-downloader/shared` |
| `@logosw/hls-downloader/adapters`、`.../browser`、`.../node` | 同 `@hls-downloader/adapters` 及子路径 |
| `@hls-downloader/core` | `HlsDownloader` 类 |
| `@hls-downloader/shared` | 类型、`HlsDownloaderEvent`、`createAdapter` 等 |
| `@hls-downloader/adapters/browser` | 浏览器适配器 `BrowserAdapter` |
| `@hls-downloader/adapters/node` | Node 适配器 `NodeAdapter` |

## 合规

请仅处理您有权访问的流地址，并遵守来源站点条款与适用法律。
