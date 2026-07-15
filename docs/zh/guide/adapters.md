# 适配器

HLS Downloader 使用适配器模式来支持不同运行环境。请根据你的环境选择对应的适配器：

- **浏览器** — `BrowserAdapter`
- **Node.js** — `NodeAdapter`（Rust N-API 原生实现）

::: warning 默认 Transmux
**普通 `download()` 会保留源编码并 transmux 为 MP4。** BrowserAdapter 使用 [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly，NodeAdapter 使用其原生实现。

浏览器转码使用 Mediabunny 与 WebCodecs；Node 转码才会按需加载原生 FFmpeg。
:::

## BrowserAdapter（浏览器）

```ts
import { BrowserAdapter } from '@hls-downloader/adapters/browser'
// 或
import { BrowserAdapter } from '@logosw/hls-downloader/adapters/browser'
```

浏览器适配器的普通下载使用 [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly。`download()` 返回经典 fast-start MP4；`downloadToStream()` 输出适用于 MSE 的 fragmented MP4 分块。

传入 `transcode` 时，Mediabunny 使用 WebCodecs 转码 — BrowserAdapter 不再附带或加载 `ffmpeg.wasm`。支持 `h264`、`hevc`、`vp9` 预设及可选的 `videoBitrate`、`audioBitrate`。编码支持情况取决于当前浏览器的 `VideoEncoder.isConfigSupported()` 与 `AudioEncoder.isConfigSupported()`。

WASM 模块仅在开始 transmux 时按需加载。发布二进制在 HTTP 压缩前约 575 KiB（参考 Next.js 构建传输约 210 KiB）。BrowserAdapter 不要求跨域隔离或 `SharedArrayBuffer`。

### 性能（参考）

基于仓库内 8 分片 fixture（Chrome 150 / macOS，CPU 路径，3 次运行中位数；transmux 计时不含网络预取）：

| 路径 | 新引擎 | 对照基线 | 中位墙钟时间 | 加速比 |
|------|--------|----------|--------------|--------|
| Transmux | `hls-transmux` WASM | Mediabunny remux | ~1.9 ms vs ~9.5 ms | ≈ **5.0×** |
| Transcode（H.264） | Mediabunny WebCodecs | `ffmpeg.wasm`（多线程） | ~531 ms vs ~1164 ms | ≈ **2.2×** |

### 示例

```ts
const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  options: {
    download: {
      headers: { Authorization: 'Bearer ...' },
      concurrency: 5,
    },
    transcode: {
      preset: 'h264',
      videoBitrate: '4M',
    },
  },
})
```

## NodeAdapter（Node.js）

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node'
// 或
import { NodeAdapter } from '@logosw/hls-downloader/adapters/node'
```

Rust 适配器加载通过 N-API 构建的原生 `.node` 模块。**默认下载走原生 transmux，不初始化 FFmpeg。**

### 何时加载 FFmpeg（NodeAdapter）

| API | FFmpeg | 触发条件 |
|-----|--------|---------|
| `download()`（默认） | 否 | 省略 `transcode` 且未启用 `aria2.enabled` |
| `download()` | 是 | `transcode` 对象、`globalOptions.transcode`，或 **`aria2.enabled: true`** |
| `getPosterUrl()` | 视情况 | 轻量提取失败 → FFmpeg 回退 |
| `parseHls()` / `init()` | 否 | — |

### 要求

- Node.js ≥ 20
- 原生 `.node` 二进制文件需匹配你的平台和 Node ABI
- 可选：若启用 aria2 下载分片，请安装 [aria2](https://aria2.github.io/)，并保证 `aria2c` 在 `PATH` 中（或通过 `aria2.path` 指定）；需在 `aria2` 中设置 `enabled: true`

### NodeAdapter 选项

通过 `HlsDownloader` 的 `options` / `setOptions` 或单次 `download()` 传入：

| 字段 | 类型 |
|------|------|
| `aria2` | `object` |

#### `aria2`

完整字段见[适配器 API](../api/adapters.md)。设置 `enabled: true` 以使用 aria2 下载分片。

### 示例

```ts
import { HlsDownloader } from '@hls-downloader/core'
import { NodeAdapter } from '@hls-downloader/adapters/node'

const downloader = new HlsDownloader({
  adapter: NodeAdapter,
  options: {
    download: {
      concurrency: 8,
      maxRetry: 5,
    },
    aria2: {
      enabled: true,
      maxConcurrentDownloads: 16,
    },
  },
})

await downloader.init()

const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  filename: 'output',
})
```

::: warning
不要将 Node 适配器（原生 `.node` 模块）打包进浏览器代码。浏览器打包时请只导入 browser 子路径。
:::
