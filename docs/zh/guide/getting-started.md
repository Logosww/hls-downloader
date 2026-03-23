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

`@logosw/hls-downloader` 依赖 `@hls-downloader/core`、`@hls-downloader/shared`、`@hls-downloader/adapters`；`@hls-downloader/core` 已依赖 `@hls-downloader/shared`。使用适配器时均需能解析到 `@hls-downloader/adapters` 中的 wasm/rust 实现。

**运行环境**：Node.js **≥ 20**。Rust 适配器在 Node 下会加载**原生 `.node` 模块**，需使用与你平台、Node ABI 匹配的发布产物；若在浏览器打包，请只打包 **WASM** 子路径，不要把 Node 原生模块打进前端。

## 基本用法

```ts
import { HlsDownloader } from '@hls-downloader/core'
import { HlsDownloaderEvent } from '@hls-downloader/shared'
import { WasmAdapter } from '@hls-downloader/adapters/wasm'

const downloader = new HlsDownloader({
  adapter: WasmAdapter,
  option: {
    // 可选：与适配器相关的额外选项
  },
  onEvent: (event, progress) => {
    if (
      event === HlsDownloaderEvent.DOWNLOADING_SEGMENTS ||
      event === HlsDownloaderEvent.STICHING_SEGMENTS
    ) {
      console.log(progress?.completed, '/', progress?.total)
    }
  },
})

// 下载前必须先 init（WASM 会在此加载 FFmpeg）
await downloader.init()

// 仅解析主/子 playlist，不下载分片
const parsed = await downloader.parseHls({
  url: 'https://example.com/master.m3u8',
  headers: { Authorization: 'Bearer ...' },
})

// 解析并下载合并
const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  headers: {},
  filename: 'output.mp4',
})

if (result) {
  console.log(result.totalSegments)
}

// 尝试从流中取封面图 URL
const poster = await downloader.getPosterUrl({ url: '...' })
```

也可以使用聚合包导入：

```ts
import { HlsDownloader, HlsDownloaderEvent, WasmAdapter } from '@logosw/hls-downloader'
```

Node.js 侧将 `WasmAdapter` 换成 `RustAdapter` 即可：

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust'

const downloader = new HlsDownloader({
  adapter: RustAdapter,
  onEvent: (event, progress) => {
    // ...
  },
})
await downloader.init()
```

## 包与子路径

| 包 / 入口 | 用途 |
|-----------|------|
| `@logosw/hls-downloader` | 聚合入口：默认导出 `HlsDownloader`，并再导出 `shared`、WASM/Rust 适配器等 |
| `@logosw/hls-downloader/core` | 同 `@hls-downloader/core` |
| `@logosw/hls-downloader/shared` | 同 `@hls-downloader/shared` |
| `@logosw/hls-downloader/adapters`、`.../wasm`、`.../rust` | 同 `@hls-downloader/adapters` 及子路径 |
| `@hls-downloader/core` | `HlsDownloader` 类 |
| `@hls-downloader/shared` | 类型、`HlsDownloaderEvent`、`createAdapter` 等 |
| `@hls-downloader/adapters/wasm` | 浏览器适配器 `WasmAdapter` |
| `@hls-downloader/adapters/rust` | Node 适配器 `RustAdapter` |

## 合规

请仅处理您有权访问的流地址，并遵守来源站点条款与适用法律。
