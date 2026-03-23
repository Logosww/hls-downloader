# Getting Started

## Installation

**Option A — umbrella package `@logosww/hls-downloader` (recommended):**

One install exposes the same APIs as the scoped packages, with subpaths mirroring `@hls-downloader/*`:

```bash
pnpm add @logosww/hls-downloader
```

**Option B — granular packages** (smaller install surface):

```bash
pnpm add @hls-downloader/core @hls-downloader/shared
pnpm add @hls-downloader/adapters
```

The `@logosww/hls-downloader` package depends on `@hls-downloader/core`, `@hls-downloader/shared`, and `@hls-downloader/adapters`. `@hls-downloader/core` depends on `@hls-downloader/shared`. For adapters, the wasm/rust implementations must resolve (via the umbrella or explicit `@hls-downloader/adapters`).

**Runtime**: Node.js **≥ 20**. The Rust adapter loads a **native `.node` addon** on Node — use a build that matches your platform and Node ABI. For browser bundles, only include the **WASM** subpath; do not bundle the Node native addon into frontend code.

## Basic Usage

```ts
import { HlsDownloader } from '@hls-downloader/core'
import { HlsDownloaderEvent } from '@hls-downloader/shared'
import { WasmAdapter } from '@hls-downloader/adapters/wasm'

const downloader = new HlsDownloader({
  adapter: WasmAdapter,
  option: {
    // Optional: adapter-specific options
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

// Must call init before download (WASM loads FFmpeg here)
await downloader.init()

// Parse master/media playlist only; does not fetch segments
const parsed = await downloader.parseHls({
  url: 'https://example.com/master.m3u8',
  headers: { Authorization: 'Bearer ...' },
})

// Parse, fetch, and merge
const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  headers: {},
  filename: 'output.mp4',
})

if (result) {
  console.log(result.totalSegments)
}

// Try to get a poster image URL from the stream
const poster = await downloader.getPosterUrl({ url: '...' })
```

You can also use the umbrella import:

```ts
import { HlsDownloader, HlsDownloaderEvent, WasmAdapter } from '@logosww/hls-downloader'
```

On Node.js, swap `WasmAdapter` for `RustAdapter`:

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust'

const downloader = new HlsDownloader({
  adapter: RustAdapter,
  onEvent: (event, progress) => {
    // ...
  },
})
await downloader.init()
```

## Packages and Subpaths

| Package / Entry | Role |
|-----------------|------|
| `@logosww/hls-downloader` | Umbrella: default export `HlsDownloader`, re-exports `shared`, WASM/Rust adapters |
| `@logosww/hls-downloader/core` | Same as `@hls-downloader/core` |
| `@logosww/hls-downloader/shared` | Same as `@hls-downloader/shared` |
| `@logosww/hls-downloader/adapters`, `.../wasm`, `.../rust` | Same as `@hls-downloader/adapters` and subpaths |
| `@hls-downloader/core` | `HlsDownloader` class |
| `@hls-downloader/shared` | Types, `HlsDownloaderEvent`, `createAdapter`, etc. |
| `@hls-downloader/adapters/wasm` | Browser adapter `WasmAdapter` |
| `@hls-downloader/adapters/rust` | Node adapter `RustAdapter` |

## Compliance

Only use streams you are allowed to access, and follow the source site's terms and applicable law.
