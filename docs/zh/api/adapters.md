# 适配器 API

## WasmAdapter

```ts
import { WasmAdapter } from '@hls-downloader/adapters/wasm'
```

WASM 适配器底层使用 `@ffmpeg/ffmpeg`，在 WebAssembly 中编译并运行 FFmpeg，适用于浏览器环境。

初始化时，适配器会自动检测 `crossOriginIsolated` 和 `SharedArrayBuffer` 是否可用来判断多线程支持。若不可用，则自动降级到单线程 `@ffmpeg/core` 构建，避免 `init()` 挂起。

### 额外选项

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `coreURL` | `string` | CDN 地址 | FFmpeg 核心 JavaScript URL |
| `wasmURL` | `string` | CDN 地址 | FFmpeg WASM 二进制 URL |
| `workerURL` | `string` | CDN 地址 | FFmpeg Worker URL |
| `disableMultiThread` | `boolean` | `false` | 禁用多线程（不加载 Worker） |

## RustAdapter

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust'
```

Rust 适配器加载原生 `.node` N-API 模块。提供原生性能的 HLS 解析、分片下载和流合并。

### 平台支持

原生模块必须匹配你的操作系统和 Node.js ABI。常见平台已发布预构建二进制文件。
