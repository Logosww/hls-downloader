# Adapters

HLS Downloader uses an adapter pattern to support different runtimes. Choose the adapter that matches your environment:

- **Browser** — `BrowserAdapter`
- **Node.js** — `NodeAdapter` (Rust N-API native implementation)

::: warning Transmux by default
**Ordinary `download()` preserves source codecs and transmuxes to MP4.** BrowserAdapter uses [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly; NodeAdapter uses its native implementation.

Browser transcoding uses Mediabunny and WebCodecs. Node transcoding loads native FFmpeg on demand.
:::

## BrowserAdapter (Browser)

```ts
import { BrowserAdapter } from '@hls-downloader/adapters/browser'
// or
import { BrowserAdapter } from '@logosw/hls-downloader/adapters/browser'
```

The browser adapter uses [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly for ordinary downloads. `download()` returns a classic fast-start MP4; `downloadToStream()` emits fragmented MP4 chunks suitable for MSE.

When `transcode` is provided, Mediabunny uses WebCodecs — BrowserAdapter does not ship or load `ffmpeg.wasm`. Supported presets are `h264`, `hevc`, and `vp9`, with optional `videoBitrate` and `audioBitrate`. Codec support depends on `VideoEncoder.isConfigSupported()` and `AudioEncoder.isConfigSupported()` in the current browser.

The WASM module is loaded only when transmuxing starts. The shipped binary is about 575 KiB before HTTP compression (about 210 KiB transferred in the reference Next.js build). BrowserAdapter does not require cross-origin isolation or `SharedArrayBuffer`.

### Performance (reference)

On the package 8-segment fixture (Chrome 150 / macOS, CPU path, median of 3 runs; transmux timing excludes network prefetch):

| Path | New engine | Baseline | Median wall | Speedup |
|------|------------|----------|-------------|---------|
| Transmux | `hls-transmux` WASM | Mediabunny remux | ~1.9 ms vs ~9.5 ms | ≈ **5.0×** |
| Transcode (H.264) | Mediabunny WebCodecs | `ffmpeg.wasm` (multi-thread) | ~531 ms vs ~1164 ms | ≈ **2.2×** |

### Example

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

## NodeAdapter (Node.js)

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
  filename: 'output',
})
```

::: warning
Do not bundle the Node adapter (native `.node` addon) into browser code. For browser bundles, only import the browser subpath.
:::
