# Adapter API

Adapter-specific fields are passed via `HlsDownloader` constructor `options` / `setOptions`, or per-call on `download()`. They are merged with per-call options taking precedence.

::: info Transmux first, FFmpeg on demand
Across adapters, **default downloads transmux/remux without FFmpeg**. FFmpeg is initialized only when a specific API needs it. The tables below list **when FFmpeg loads** for each adapter.
:::

## BrowserAdapter

```ts
import { BrowserAdapter } from '@hls-downloader/adapters/browser'
```

Ordinary downloads use a **lightweight browser transmux path**. **`@ffmpeg/ffmpeg` is not loaded** unless one of the FFmpeg scenarios below applies.

### When FFmpeg loads

| API | Loads FFmpeg? | Condition |
|-----|---------------|-----------|
| `parseHls()` | No | — |
| `init()` | No | — |
| `download()` | **No** (default) | Omit `transcode` and `globalOptions.transcode` → transmux only |
| `download()` | **Yes** | `transcode` with a `preset` or explicit output codecs, or `globalOptions.transcode` |
| `getPosterUrl()` | No | Uses segment-based extraction only |

When FFmpeg is loaded, the adapter automatically detects whether multi-threading is available by checking `crossOriginIsolated` and `SharedArrayBuffer`. If not available, it falls back to the single-threaded `@ffmpeg/core` build.

For FFmpeg core assets, **ESM** vs **UMD** paths on the CDN are controlled by `ffmpeg.useESM` (`true` → `esm/`, omitted or `false` → `umd/`).

`WasmAdapter` remains available as a deprecated compatibility alias. Prefer `BrowserAdapter` in new code.

### `download()` result

| Field | Type |
|-------|------|
| `blobURL` | `string` |
| `totalSegments` | `number` |

### Adapter-specific options

| Field | Type |
|-------|------|
| `ffmpeg` | `object` |

#### `ffmpeg` object

| Field | Type |
|-------|------|
| `coreURL` | `string` |
| `wasmURL` | `string` |
| `workerURL` | `string` |
| `useESM` | `boolean` |
| `disableMultiThread` | `boolean` |

## NodeAdapter

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node'
```

Ordinary downloads use a **native transmux path**. **Native FFmpeg is not initialized** unless one of the FFmpeg scenarios below applies.

`RustAdapter` remains available as a deprecated compatibility alias. Prefer `NodeAdapter` in new code.

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
