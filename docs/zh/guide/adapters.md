# 适配器

HLS Downloader 使用适配器模式来支持不同运行环境。请根据你的环境选择对应的适配器：

- **浏览器** — `WasmAdapter`（FFmpeg WASM）
- **Node.js** — `RustAdapter`（Rust N-API 原生实现）

两种适配器通过 `HlsDownloader` 类暴露相同的 API，唯一的区别在于导入路径和初始化行为。

## WASM 适配器（浏览器）

```ts
import { WasmAdapter } from '@hls-downloader/adapters/wasm'
// 或
import { WasmAdapter } from '@logosww/hls-downloader/adapters/wasm'
```

WASM 适配器使用编译为 WebAssembly 的 FFmpeg。在 `init()` 时，它会加载 FFmpeg 核心、WASM 二进制文件，以及可选的 Worker（用于多线程）。

### WASM 专有选项

在 `HlsDownloader` 构造函数的 `option` 对象中传入：

| 选项 | 类型 | 描述 |
|------|------|------|
| `coreURL` | `string` | 自定义 FFmpeg 核心 JS 地址（默认指向 CDN） |
| `wasmURL` | `string` | 自定义 FFmpeg WASM 二进制地址 |
| `workerURL` | `string` | 自定义 FFmpeg Worker 地址 |
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
import { RustAdapter } from '@logosww/hls-downloader/adapters/rust'
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
