# Getting Started

## Installation

**Option A — umbrella package `@logosw/hls-downloader` (recommended):**

One install exposes the same APIs as the scoped packages, with subpaths mirroring `@hls-downloader/*`:

```bash
pnpm add @logosw/hls-downloader
```

**Option B — granular packages** (smaller install surface):

```bash
pnpm add @hls-downloader/core @hls-downloader/shared
pnpm add @hls-downloader/adapters
```

The `@logosw/hls-downloader` package depends on `@hls-downloader/core`, `@hls-downloader/shared`, and `@hls-downloader/adapters`. `@hls-downloader/core` depends on `@hls-downloader/shared`. For adapters, the wasm/rust implementations must resolve (via the umbrella or explicit `@hls-downloader/adapters`).

**Runtime**: Node.js **≥ 20**. The Rust adapter loads a **native `.node` addon** on Node — use a build that matches your platform and Node ABI. For browser bundles, only include the **WASM** subpath; do not bundle the Node native addon into frontend code.

::: info Default download path (transmux)
**Ordinary `download()` does not load FFmpeg.** Segments are merged via a lightweight transmux/remux path while keeping source codecs. Pass `transcode` on `download()` (or set `globalOptions.transcode`) only when you need FFmpeg-based merging or transcoding. See [Adapters](/guide/adapters) for per-adapter FFmpeg triggers.
:::

## Basic Usage

```ts
import { HlsDownloader } from '@hls-downloader/core'
import { HlsDownloaderEvent } from '@hls-downloader/shared'
import { BrowserAdapter } from '@hls-downloader/adapters/browser'

const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  options: {
    download: { headers: { Authorization: 'Bearer ...' } },
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

// init() is lightweight and does not load FFmpeg
await downloader.init()

// Parse playlist only — no segments, no FFmpeg
const parsed = await downloader.parseHls({
  url: 'https://example.com/master.m3u8',
  headers: { Authorization: 'Bearer ...' },
})

// Default download — transmux only, no FFmpeg
const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  headers: {},
  filename: 'output.mp4',
})

// Explicit transcode — loads FFmpeg (see Adapter docs)
// await downloader.download({ url: '...', transcode: { preset: 'h264' } })

if (result) {
  console.log(result.totalSegments)
}

// Try to get a poster image URL from the stream
const poster = await downloader.getPosterUrl({ url: '...' })
```

You can also use the umbrella import:

```ts
import { HlsDownloader, HlsDownloaderEvent, BrowserAdapter } from '@logosw/hls-downloader'
```

On Node.js, swap `BrowserAdapter` for `NodeAdapter`:

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node'

const downloader = new HlsDownloader({
  adapter: NodeAdapter,
  onEvent: (event, progress) => {
    // ...
  },
})
await downloader.init()
```

## Packages and Subpaths

| Package / Entry | Role |
|-----------------|------|
| `@logosw/hls-downloader` | Umbrella: default export `HlsDownloader`, re-exports `shared`, WASM/Rust adapters |
| `@logosw/hls-downloader/core` | Same as `@hls-downloader/core` |
| `@logosw/hls-downloader/shared` | Same as `@hls-downloader/shared` |
| `@logosw/hls-downloader/adapters`, `.../browser`, `.../node` | Same as `@hls-downloader/adapters` and subpaths (`.../wasm`, `.../rust` are deprecated aliases) |
| `@hls-downloader/core` | `HlsDownloader` class |
| `@hls-downloader/shared` | Types, `HlsDownloaderEvent`, `createAdapter`, etc. |
| `@hls-downloader/adapters/browser` | Browser adapter `BrowserAdapter` |
| `@hls-downloader/adapters/node` | Node adapter `NodeAdapter` |

## Compliance

Only use streams you are allowed to access, and follow the source site's terms and applicable law.
