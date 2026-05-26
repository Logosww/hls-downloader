# Adapters

HLS Downloader uses an adapter pattern to support different runtimes. Choose the adapter that matches your environment:

- **Browser** — `BrowserAdapter`
- **Node.js** — `NodeAdapter` (Rust N-API native implementation)

::: warning Transmux by default — FFmpeg only when needed
**Ordinary `download()` uses a lightweight transmux/remux path and does not load FFmpeg.** Source codecs are preserved (e.g. remux to MP4).

FFmpeg is loaded **on demand** only when a specific API requires it. **`init()` and `parseHls()` never load FFmpeg.** To transcode on download, pass `transcode` with a `preset` or explicit output codecs (or set `globalOptions.transcode`).

See each adapter section below for **when FFmpeg loads**.
:::

## WASM Adapter (Browser)

```ts
import { BrowserAdapter } from '@hls-downloader/adapters/browser'
// or
import { BrowserAdapter } from '@logosw/hls-downloader/adapters/browser'
```

The browser adapter performs ordinary downloads with a **lightweight transmux path** — **no `@ffmpeg/ffmpeg`**.

### When FFmpeg loads (BrowserAdapter)

| API | FFmpeg | Trigger |
|-----|--------|---------|
| `download()` (default) | No | Omit `transcode` |
| `download()` | Yes | `transcode` with a `preset` or explicit output codecs, or `globalOptions.transcode` |
| `getPosterUrl()` | No | Segment-based extraction only |
| `parseHls()` / `init()` | No | — |

When FFmpeg **is** loaded for transcoding, it is compiled to WebAssembly. **BrowserAdapter only accepts `{ preset: 'h264' }`** — use `NodeAdapter` for other presets or fine-grained options. See [Adapter API](../api/adapters.md) for `ffmpeg` options (`coreURL`, `useESM`, etc.).

### Cross-Origin Isolation & Auto Fallback

The multi-threaded FFmpeg build (`@ffmpeg/core-mt`) relies on `SharedArrayBuffer`, which is only available when the page is **cross-origin isolated** — i.e. the server responds with both:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless` (or `require-corp`)

When FFmpeg is needed, the adapter **automatically detects** whether the runtime supports multi-threading by checking `globalThis.crossOriginIsolated` and `SharedArrayBuffer` availability. If the environment does not meet the requirements, it **silently falls back** to the single-threaded build (`@ffmpeg/core`).

You can also force single-threaded mode via `ffmpeg.disableMultiThread`.

::: tip
`WasmAdapter` is still exported for compatibility, but it is deprecated. Prefer `BrowserAdapter` in new code.
:::

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

By default the adapter loads the **UMD** build from the CDN. For bundlers such as **Vite** that resolve ESM better, set `ffmpeg.useESM: true` in `options`.

### BrowserAdapter options

Pass via `HlsDownloader` `options` / `setOptions`, or per-call on `download()`:

| Field | Type |
|-------|------|
| `ffmpeg` | `object` |

#### `ffmpeg`

| Field | Type |
|-------|------|
| `coreURL` | `string` |
| `wasmURL` | `string` |
| `workerURL` | `string` |
| `useESM` | `boolean` |
| `disableMultiThread` | `boolean` |

### Example

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

## Rust Adapter (Node.js)

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node'
// or
import { NodeAdapter } from '@logosw/hls-downloader/adapters/node'
```

The Rust adapter loads a native `.node` addon built with N-API. **Default downloads use native transmux without initializing FFmpeg.**

### When FFmpeg loads (NodeAdapter)

| API | FFmpeg | Trigger |
|-----|--------|---------|
| `download()` (default) | No | Omit `transcode` and `aria2.enabled` |
| `download()` | Yes | `transcode` object, `globalOptions.transcode`, or **`aria2.enabled: true`** |
| `getPosterUrl()` | Sometimes | Lightweight extraction failed → FFmpeg fallback |
| `parseHls()` / `init()` | No | — |

`RustAdapter` is still exported for compatibility, but it is deprecated. Prefer `NodeAdapter` in new code.

### Requirements

- Node.js ≥ 20
- The native `.node` binary must match your platform and Node ABI
- Optional: [aria2](https://aria2.github.io/) (`aria2c` on your `PATH`, or a custom path via `aria2.path`) when `aria2.enabled` is `true`

### NodeAdapter options

Pass via `HlsDownloader` `options` / `setOptions`, or per-call on `download()`:

| Field | Type |
|-------|------|
| `aria2` | `object` |

#### `aria2`

See [Adapter API](../api/adapters.md) for all fields. Set `enabled: true` to download segments with aria2.

### Example

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
  filename: 'output.mp4',
})
```

::: warning
Do not bundle the Rust adapter (native `.node` addon) into browser code. For browser bundles, only import the WASM subpath.
:::
