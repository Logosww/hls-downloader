# Adapter API

Adapter-specific fields are passed via `HlsDownloader` constructor `options` / `setOptions`, or per-call on `download()`. They are merged with per-call options taking precedence.

::: info Transmux first
Across adapters, **default downloads transmux/remux without re-encoding**. BrowserAdapter uses [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly for transmux and Mediabunny WebCodecs for `transcode`; NodeAdapter initializes native FFmpeg only when needed.
:::

## BrowserAdapter

```ts
import { BrowserAdapter } from '@hls-downloader/adapters/browser'
```

Ordinary downloads use [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly. `download()` returns a classic fast-start MP4; `downloadToStream()` emits fragmented MP4 chunks.

Transcoding uses Mediabunny and WebCodecs without `@ffmpeg/ffmpeg`. BrowserAdapter accepts the `h264`, `hevc`, and `vp9` presets with optional `videoBitrate` and `audioBitrate`. Unsupported browser encoder configurations reject with an explicit error.

Reference CPU micro-benchmarks (8-segment fixture, Chrome 150 / macOS, median of 3): transmux ≈ **5.0×** vs Mediabunny remux; H.264 transcode ≈ **2.2×** vs multi-threaded `ffmpeg.wasm`. See [Adapters guide](/guide/adapters#performance-reference).

### `download()` result

| Field | Type |
|-------|------|
| `blobURL` | `string` |
| `totalSegments` | `number` |

## NodeAdapter

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node'
```

Ordinary downloads use a **native transmux path**. **Native FFmpeg is not initialized** unless one of the FFmpeg scenarios below applies.

### When FFmpeg loads

| API | Loads FFmpeg? | Condition |
|-----|---------------|-----------|
| `parseHls()` | No | — |
| `init()` | No | — |
| `download()` | **No** (default) | Omit `transcode` / `globalOptions.transcode` and `aria2.enabled` → transmux only |
| `download()` | **Yes** | A `transcode` options object, `globalOptions.transcode`, **or** `aria2.enabled: true` |
| `getPosterUrl()` | **Sometimes** | Only if lightweight segment extraction fails and an FFmpeg-based fallback is needed |

### `download()` result

| Field | Type |
|-------|------|
| `filePath` | `string` |
| `totalSegments` | `number` |

### Adapter-specific options

| Field | Type |
|-------|------|
| `aria2` | `object` |

Segment downloads use the built-in HTTP stack by default. Set `aria2.enabled` to `true` to use [aria2](https://aria2.github.io/) (`aria2c` CLI + session file).

When `aria2.enabled` is `true`, aria2 must be installed. Custom request headers are written into aria2’s session file (`header=Name: value` per URI).

#### `aria2` object (`NodeAdapterAria2Options`)

| Field | Type |
|-------|------|
| `enabled` | `boolean` |
| `path` | `string` |
| `maxConcurrentDownloads` | `number` |
| `maxConnectionPerServer` | `number` |
| `split` | `number` |
| `minSplitSize` | `string` |
| `extraArgs` | `string[]` |

When `maxConcurrentDownloads` is omitted, the effective concurrency follows `downloadConcurrency` on each `download()` call (or `globalOptions.download.concurrency`).

### Platform Support

The native addon must match your operating system and Node.js ABI. Pre-built binaries are published for common platforms.
