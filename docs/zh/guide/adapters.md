# 适配器

HLS Downloader 使用适配器模式来支持不同运行环境。请根据你的环境选择对应的适配器：

- **浏览器** — `WasmAdapter`（FFmpeg WASM）
- **Node.js** — `RustAdapter`（Rust N-API 原生实现）

两种适配器通过 `HlsDownloader` 类暴露相同的 API，唯一的区别在于导入路径和初始化行为。

## WASM 适配器（浏览器）

```ts
import { WasmAdapter } from '@hls-downloader/adapters/wasm'
// 或
import { WasmAdapter } from '@logosw/hls-downloader/adapters/wasm'
```

WASM 适配器使用编译为 WebAssembly 的 FFmpeg。在 `init()` 时，它会加载 FFmpeg 核心、WASM 二进制文件，以及可选的 Worker（用于多线程）。

### 跨域隔离与自动降级

多线程 FFmpeg 构建（`@ffmpeg/core-mt`）依赖 `SharedArrayBuffer`，而 `SharedArrayBuffer` 仅在页面处于**跨域隔离**状态时可用——即服务器需同时返回以下两个响应头：

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless`（或 `require-corp`）

WASM 适配器会在 `init()` 时**自动检测**运行时是否支持多线程（通过检查 `globalThis.crossOriginIsolated` 和 `SharedArrayBuffer` 的可用性）。如果环境不满足条件，将**静默降级**到单线程构建（`@ffmpeg/core`），确保 `init()` 始终能正常完成，不会挂起。

你也可以通过 `disableMultiThread` 选项手动强制使用单线程模式。

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

### Vite 与 ESM 资源路径

在 Vite 等提供 `import.meta.env` 的环境中，使用 CDN 上的 **ESM** 版 FFmpeg 通常更稳妥。适配器会**自动检测**该环境并默认选用 ESM 路径。若需强制某种模式，可在 `option` 中设置 `useESM: true` 或 `useESM: false`，**显式配置优先于自动检测**。

### WASM 专有选项

在 `HlsDownloader` 构造函数的 `option` 对象中传入：

| 选项 | 类型 | 描述 |
|------|------|------|
| `coreURL` | `string` | 自定义 FFmpeg 核心 JS 地址（默认指向 CDN） |
| `wasmURL` | `string` | 自定义 FFmpeg WASM 二进制地址 |
| `workerURL` | `string` | 自定义 FFmpeg Worker 地址 |
| `useESM` | `boolean` | 使用 ESM 或 UMD 的 CDN 路径；省略时按 Vite 环境自动选择 |
| `disableMultiThread` | `boolean` | 使用单线程 FFmpeg 构建（不加载 Worker） |

### 示例

```ts
const downloader = new HlsDownloader({
  adapter: WasmAdapter,
  option: {
    coreURL: '/ffmpeg/ffmpeg-core.js',
    wasmURL: '/ffmpeg/ffmpeg-core.wasm',
    disableMultiThread: true,
  },
})
```

## Rust 适配器（Node.js）

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust'
// 或
import { RustAdapter } from '@logosw/hls-downloader/adapters/rust'
```

Rust 适配器加载通过 N-API 构建的原生 `.node` 模块。相比 WASM 适配器，它提供更好的性能和路径处理能力，是服务端使用的首选。

### 要求

- Node.js ≥ 20
- 原生 `.node` 二进制文件需匹配你的平台和 Node ABI

### 示例

```ts
import { HlsDownloader } from '@hls-downloader/core'
import { RustAdapter } from '@hls-downloader/adapters/rust'

const downloader = new HlsDownloader({
  adapter: RustAdapter,
})

await downloader.init()

const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  filename: 'output.mp4',
})
```

::: warning
不要将 Rust 适配器（原生 `.node` 模块）打包进浏览器代码。浏览器打包时请只导入 WASM 子路径。
:::
