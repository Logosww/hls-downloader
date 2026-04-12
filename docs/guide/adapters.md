# Adapters

HLS Downloader uses an adapter pattern to support different runtimes. Choose the adapter that matches your environment:

- **Browser** — `WasmAdapter` (FFmpeg WASM)
- **Node.js** — `RustAdapter` (Rust N-API native implementation)

Both adapters expose the same API through the `HlsDownloader` class. The only difference is the import path and initialization behavior.

## WASM Adapter (Browser)

```ts
import { WasmAdapter } from '@hls-downloader/adapters/wasm'
// or
import { WasmAdapter } from '@logosw/hls-downloader/adapters/wasm'
```

The WASM adapter uses FFmpeg compiled to WebAssembly. During `init()`, it loads the FFmpeg core, WASM binary, and optionally a worker for multi-threading.

### Cross-Origin Isolation & Auto Fallback

The multi-threaded FFmpeg build (`@ffmpeg/core-mt`) relies on `SharedArrayBuffer`, which is only available when the page is **cross-origin isolated** — i.e. the server responds with both:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless` (or `require-corp`)

The WASM adapter **automatically detects** whether the runtime supports multi-threading by checking `globalThis.crossOriginIsolated` and `SharedArrayBuffer` availability. If the environment does not meet the requirements, it **silently falls back** to the single-threaded build (`@ffmpeg/core`), so `init()` will always succeed without hanging.

You can also force single-threaded mode via the `disableMultiThread` option.

::: tip
If you're using Next.js or a similar framework, set the headers in your server config (e.g. `next.config.ts`) to enable cross-origin isolation and unlock multi-threaded performance:

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

### ESM vs UMD FFmpeg assets

By default the adapter loads the **UMD** build from the CDN. For bundlers such as **Vite** that resolve ESM better, set `useESM: true` in `option`.

### WASM-Specific Options

Pass these as part of the `option` object in the `HlsDownloader` constructor:

| Option | Type | Description |
|--------|------|-------------|
| `coreURL` | `string` | Custom FFmpeg core JS URL (defaults to CDN) |
| `wasmURL` | `string` | Custom FFmpeg WASM binary URL |
| `workerURL` | `string` | Custom FFmpeg worker URL |
| `useESM` | `boolean` | `true` for CDN `esm/` paths (e.g. Vite); omit or `false` for `umd/` (default) |
| `disableMultiThread` | `boolean` | Use single-thread FFmpeg build (no worker) |

### Example

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

## Rust Adapter (Node.js)

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust'
// or
import { RustAdapter } from '@logosw/hls-downloader/adapters/rust'
```

The Rust adapter loads a native `.node` addon built with N-API. It provides better performance and path handling compared to the WASM adapter, making it the preferred choice for server-side usage.

### Requirements

- Node.js ≥ 20
- The native `.node` binary must match your platform and Node ABI

### Example

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
Do not bundle the Rust adapter (native `.node` addon) into browser code. For browser bundles, only import the WASM subpath.
:::
