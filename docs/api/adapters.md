# Adapter API

## WasmAdapter

```ts
import { WasmAdapter } from '@hls-downloader/adapters/wasm'
```

The WASM adapter uses `@ffmpeg/ffmpeg` under the hood. It compiles and runs FFmpeg in WebAssembly, making it suitable for browser environments.

During initialization, the adapter automatically detects whether multi-threading is available by checking `crossOriginIsolated` and `SharedArrayBuffer`. If not available, it falls back to the single-threaded `@ffmpeg/core` build to prevent `init()` from hanging.

### Additional Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `coreURL` | `string` | CDN URL | FFmpeg core JavaScript URL |
| `wasmURL` | `string` | CDN URL | FFmpeg WASM binary URL |
| `workerURL` | `string` | CDN URL | FFmpeg worker URL |
| `disableMultiThread` | `boolean` | `false` | Disable multi-threading (skip worker) |

## RustAdapter

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust'
```

The Rust adapter loads a native `.node` N-API addon. It provides native performance for HLS parsing, segment downloading, and stream merging.

### Platform Support

The native addon must match your operating system and Node.js ABI. Pre-built binaries are published for common platforms.
