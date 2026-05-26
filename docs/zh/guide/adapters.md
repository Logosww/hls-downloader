# 适配器

HLS Downloader 使用适配器模式来支持不同运行环境。请根据你的环境选择对应的适配器：

- **浏览器** — `BrowserAdapter`
- **Node.js** — `NodeAdapter`（Rust N-API 原生实现）

::: warning 默认 Transmux — 仅在需要时加载 FFmpeg
**普通 `download()` 走轻量 transmux/remux 路径，不会加载 FFmpeg。** 保留源编码（例如 remux 为 MP4）。

FFmpeg **仅在按需**、且具体 API 需要时才加载。**`init()` 与 `parseHls()` 均不会加载 FFmpeg。** 若要在下载时转码，请传入带 `preset`、显式输出编码或 `format` 的 `transcode`（或设置 `globalOptions.transcode`）。

各适配器**何时加载 FFmpeg** 见下方分节。
:::

## WASM 适配器（浏览器）

```ts
import { BrowserAdapter } from '@hls-downloader/adapters/browser'
// 或
import { BrowserAdapter } from '@logosw/hls-downloader/adapters/browser'
```

浏览器适配器的普通下载走**轻量 transmux 路径** — **不加载 `@ffmpeg/ffmpeg`**。

### 何时加载 FFmpeg（BrowserAdapter）

| API | FFmpeg | 触发条件 |
|-----|--------|---------|
| `download()`（默认） | 否 | 省略 `transcode` |
| `download()` | 是 | 带 `preset`、显式输出编码或 `format` 的 `transcode`，或 `globalOptions.transcode` |
| `getPosterUrl()` | 否 | 仅基于分片的轻量提取 |
| `parseHls()` / `init()` | 否 | — |

当因转码**确实需要**加载 FFmpeg 时，其为 WebAssembly 构建。**BrowserAdapter 仅接受 `{ preset: 'h264' }`**；其他 preset 或细粒度选项请用 `NodeAdapter`。`ffmpeg` 选项（`coreURL`、`useESM` 等）见[适配器 API](../api/adapters.md)。

### 跨域隔离与自动降级

多线程 FFmpeg 构建（`@ffmpeg/core-mt`）依赖 `SharedArrayBuffer`，而 `SharedArrayBuffer` 仅在页面处于**跨域隔离**状态时可用——即服务器需同时返回以下两个响应头：

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`（或 `require-corp`）

当需要 FFmpeg 时，适配器会**自动检测**运行时是否支持多线程（通过检查 `globalThis.crossOriginIsolated` 和 `SharedArrayBuffer` 的可用性）。如果环境不满足条件，将**静默降级**到单线程构建（`@ffmpeg/core`）。

你也可以通过 `ffmpeg.disableMultiThread` 手动强制使用单线程模式。

::: tip
`WasmAdapter` 仍作为兼容导出保留，但已 deprecated。新代码请优先使用 `BrowserAdapter`。
:::

::: tip
如果你使用 Next.js 或类似框架，可在服务端配置中（如 `next.config.ts`）设置响应头以启用跨域隔离，从而解锁多线程性能：

```ts
async headers() {
  return [{
    source: '/:path*',
    headers: [
      { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ],
  }]
}
```
:::

### ESM 与 UMD 资源路径

默认从 CDN 加载 **UMD** 构建。若在 **Vite** 等更适合 ESM 的打包环境中使用，请在 `options` 中设置 `ffmpeg.useESM: true`。

### BrowserAdapter 选项

通过 `HlsDownloader` 的 `options` / `setOptions` 或单次 `download()` 传入：

| 字段 | 类型 |
|------|------|
| `ffmpeg` | `object` |

#### `ffmpeg`

| 字段 | 类型 |
|------|------|
| `coreURL` | `string` |
| `wasmURL` | `string` |
| `workerURL` | `string` |
| `useESM` | `boolean` |
| `disableMultiThread` | `boolean` |

### 示例

```ts
const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  options: {
    download: {
      headers: { Authorization: 'Bearer ...' },
      concurrency: 5,
    },
    ffmpeg: {
      coreURL: '/ffmpeg/ffmpeg-core.js',
      wasmURL: '/ffmpeg/ffmpeg-core.wasm',
      disableMultiThread: true,
    },
  },
})
```

## Rust 适配器（Node.js）

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

`RustAdapter` 仍作为兼容导出保留，但已 deprecated。新代码请优先使用 `NodeAdapter`。

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
不要将 Rust 适配器（原生 `.node` 模块）打包进浏览器代码。浏览器打包时请只导入 WASM 子路径。
:::
