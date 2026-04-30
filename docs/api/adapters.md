# Adapter API

## WasmAdapter

```ts
import { WasmAdapter } from '@hls-downloader/adapters/wasm'
```

The WASM adapter uses `@ffmpeg/ffmpeg` under the hood. It compiles and runs FFmpeg in WebAssembly, making it suitable for browser environments.

During initialization, the adapter automatically detects whether multi-threading is available by checking `crossOriginIsolated` and `SharedArrayBuffer`. If not available, it falls back to the single-threaded `@ffmpeg/core` build to prevent `init()` from hanging.

For FFmpeg core assets, **ESM** vs **UMD** paths on the CDN are controlled only by `useESM` (`true` → `esm/`, omitted or `false` → `umd/`).

### Additional Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `coreURL` | `string` | CDN URL | FFmpeg core JavaScript URL |
| `wasmURL` | `string` | CDN URL | FFmpeg WASM binary URL |
| `workerURL` | `string` | CDN URL | FFmpeg worker URL |
| `useESM` | `boolean` | `false` | Use ESM (`true`) or UMD (`false` / omitted) FFmpeg assets from the CDN |
| `disableMultiThread` | `boolean` | `false` | Disable multi-threading (skip worker) |

## RustAdapter

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust'
```

The Rust adapter loads a native `.node` N-API addon. It provides native performance for HLS parsing, segment downloading, and stream merging.

### Additional Options

Pass these via `HlsDownloader` `options` / `setOptions` (they are merged into each `download()` call). Segment downloads use **reqwest** by default, or **aria2** (`aria2c` CLI with an input session file) when `aria2.enabled` is `true`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `aria2` | `object` | — | Optional. Enables and configures aria2 for segment downloads (see fields below). Omit to use the built-in HTTP stack. |

When `aria2.enabled` is `true`, [aria2](https://aria2.github.io/) must be installed. Custom request headers are written into aria2’s session file (`header=Name: value` per URI). If aria2 is missing or exits with an error, `download()` rejects with a clear error message.

Segment-level concurrency follows the **`downloadConcurrency`** argument on each `download()` (and the adapter’s `chunkDownloadConcurrency` default when omitted). Retries follow **`maxRetry`** (`--max-tries` for aria2).

### `aria2` object (`RustAdapterAria2Options`)

The public TypeScript alias matches the native **`NapiAria2Config`** shape passed through N-API.

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | `boolean` | Optional. When `true`, download segments with aria2. Default `false` if omitted. |
| `path` | `string` | Optional. Path to the `aria2c` executable when it is not on `PATH` (only used when `enabled` is `true`). |
| `maxConcurrentDownloads` | `number` | Optional. Maps to `--max-concurrent-downloads`. When omitted, `downloadConcurrency` is used |
| `maxConnectionPerServer` | `number` | Optional. Maps to `--max-connection-per-server` |
| `split` | `number` | Optional. Maps to `--split` |
| `minSplitSize` | `string` | Optional. Maps to `--min-split-size` (e.g. `'1M'`) |
| `extraArgs` | `string[]` | Optional. Extra CLI arguments appended after built-in flags (advanced) |

### Platform Support

The native addon must match your operating system and Node.js ABI. Pre-built binaries are published for common platforms.
