# HlsDownloader

The main facade class for downloading HLS streams. Imported from `@hls-downloader/core`.

::: info Default download path (transmux)
**Ordinary `download()` keeps source codecs and transmuxes to MP4.** BrowserAdapter uses [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly; NodeAdapter uses its native Rust path.

Re-encoding is opt-in via `transcode` — see [Adapter API](./adapters.md). BrowserAdapter loads its hls-transmux WASM module in `init()`; NodeAdapter is a no-op (FFmpeg loads on demand). `parseHls()` never starts those engines.
:::

## Constructor

```ts
new HlsDownloader({
  adapter,
  options?,
  onEvent?,
})
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `adapter` | `BrowserAdapter \| NodeAdapter` | The adapter to use |
| `options` | `GlobalOptions<T>` | Default options (see below). Merged into each `parseHls` / `download` / `getPosterUrl` call |
| `onEvent` | `(event, payload?) => void` | Event callback for tracking progress and errors |

## Properties

### `isInit`

```ts
get isInit(): boolean
```

Whether the adapter has been initialized. Returns `true` after `init()` resolves.

### `globalOptions`

```ts
get globalOptions(): GlobalOptions<T> | null
```

The current default options, or `null` if none were set.

## GlobalOptions

Exported from `@hls-downloader/core` as `GlobalOptions<T>`. The shape depends on the adapter type `T`.

| Field | Type | Description |
|-------|------|-------------|
| `download` | `HlsDownloaderGlobalDownloadOptions` | Default fetch / download settings (excluding per-call `url`) |
| `transcode` | `HlsDownloaderTranscodeOptions` | Default transcode settings |
| *(adapter-specific)* | — | See [Adapter API](./adapters.md) |

### `download` object

| Field | Type | Description |
|-------|------|-------------|
| `headers` | `Record<string, string>` | Default request headers |
| `concurrency` | `number` | Default concurrent segment downloads |
| `maxRetry` | `number` | Default max retry attempts per segment |

Per-call `download({ downloadConcurrency })` overrides `download.concurrency`.

## Methods

### `init()`

```ts
async init(): Promise<void>
```

Initialize adapter state. BrowserAdapter loads its WASM module (transmux engine) here — this is the main startup cost on the browser, so callers may want to invoke `init()` ahead of time (e.g. on page load) rather than letting it block the first `download()` / `downloadToStream()`. NodeAdapter is a no-op (FFmpeg loads on demand). The call is idempotent — repeated invocations share the same promise.

`download()` and `downloadToStream()` automatically call `init()` if not yet initialized. `parseHls()` and `getPosterUrl()` do **not** trigger `init()` and work without initialization.

### `setOptions()`

```ts
setOptions(options: GlobalOptions<T>): void
```

Replace the default options. Accepts the same shape as the constructor `options`.

### `parseHls()`

```ts
async parseHls(options: HlsDownloaderFetchOptions): Promise<ParseHlsResult>
```

Parse an HLS playlist without downloading segments. Merges `options` with `globalOptions.download` (headers only).

Returns a `ParseHlsResult`:

- `{ type: 'playlist', data: Playlist[] }` — master playlist with variant streams
- `{ type: 'segment', data: Segment[] }` — media playlist with segments
- `{ type: 'error', message: string }` — parse error

| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | HLS playlist URL |
| `headers` | `Record<string, string>` | Request headers |

### `download()`

```ts
async download(
  options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions & Partial<AdapterOptions>
): Promise<DownloadResult>
```

Parse, download all segments, and merge them into a single file. On success, **`BrowserAdapter`** resolves to `{ blobURL, totalSegments }`; **`NodeAdapter`** resolves to `{ filePath, totalSegments }`. On failure, the promise rejects.

**By default (no `transcode`)**, adapters use the transmux path and keep source codecs. Passing `transcode` opts into re-encoding: BrowserAdapter uses WebCodecs; NodeAdapter uses FFmpeg.

Merges per-call options with `globalOptions` (per-call wins).

| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | HLS playlist URL |
| `headers` | `Record<string, string>` | Request headers |
| `filename` | `string` | Output filename without extension. The extension is resolved internally from the output container (`mp4` by default, `webm` for `vp9`, or `transcode.format`) |
| `maxRetry` | `number` | Max retry attempts per segment |
| `downloadConcurrency` | `number` | Concurrent segment downloads |
| `transcode` | `HlsDownloaderTranscodeOptions` | Transcode with WebCodecs in BrowserAdapter or FFmpeg in NodeAdapter. Omit for default transmux/remux |
| `signal` | `AbortSignal` | Cooperative cancellation. When the signal aborts, the download promise rejects with an `AbortError` |
| `variant` | `VariantSelectOptions` | Master-playlist variant selection preferences. Omit for default (highest resolution → bandwidth) |
| *(adapter-specific)* | — | See [Adapter API](./adapters.md) |

BrowserAdapter supports `preset` plus `videoBitrate` and `audioBitrate`. NodeAdapter supports all fields below:

| Field | Type | Description |
|-------|------|-------------|
| `preset` | `'h264' \| 'hevc' \| 'vp9'` | Shorthand encoding profile |
| `videoCodec` | `string` | Overrides preset video codec |
| `audioCodec` | `string` | Overrides preset audio codec |
| `format` | `string` | Output container (`-f`) |
| `crf` | `number` | Quality (x264/x265/vp9) |
| `videoBitrate` | `string \| number` | Video bitrate |
| `audioBitrate` | `string \| number` | Audio bitrate |
| `speed` | `HlsDownloaderEncoderSpeed` | x264/x265 encoder preset |

#### Example: aborting a download with AbortController

```ts
const controller = new AbortController();

// Abort after 5 seconds (e.g. user clicked cancel)
setTimeout(() => controller.abort(), 5000);

try {
  await downloader.download({
    url: 'https://example.com/stream.m3u8',
    filename: 'output',
    signal: controller.signal,
  });
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('download aborted');
  } else {
    throw err;
  }
}
```

### `downloadToStream()`

::: tip BrowserAdapter & NodeAdapter
`downloadToStream()` is supported on both **`BrowserAdapter`** and **`NodeAdapter`**, but the two adapters have **different streaming semantics** (see below). On `BrowserAdapter` the fMP4 bytes flow via `onChunk` as fragmented MP4; on `NodeAdapter` bytes flow with real backpressure.
:::

```ts
async downloadToStream(
  options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions,
  onChunk: (bytes: Uint8Array) => void,
): Promise<HlsDownloaderStreamResult>
```

Parses HLS, transmuxes, and pushes fMP4 bytes through `onChunk`. **The library itself does not write to disk.**

#### Streaming behavior asymmetry

- **`NodeAdapter` — true streaming with backpressure.** Segments are downloaded and muxed concurrently; fMP4 chunks flow through `onChunk` as soon as each segment is ready. A bounded tokio channel (256 KB) provides backpressure, so a slow `onChunk` consumer naturally throttles downloading. The first `onChunk` fires after the first segment is muxed, not after the whole stream is fetched.
- **`BrowserAdapter` — batch-then-emit (not real-time).** `BrowserAdapter` first prefetches **all** segments and resources (init segments, keys) into memory with bounded concurrency, then its WASM writer emits fMP4 chunks. The first `onChunk` therefore fires **only after the entire playlist has been downloaded**; peak memory is roughly the sum of all segment sizes plus the fMP4 output. This is **not** suitable for low-latency / real-time MSE playback despite the `onChunk` API shape. True segment-by-segment streaming on the browser path is planned for a future major version.

Output is **fragmented MP4** (first segment: `ftyp`+`moov`, each subsequent segment: `styp`+`moof`+`mdat`, optional trailing `mfra`). Browser MSE can consume it directly (note the buffering caveat above for `BrowserAdapter`).

Merges per-call options with `globalOptions` (per-call wins).

| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | HLS playlist URL |
| `headers` | `Record<string, string>` | Request headers |
| `filename` | `string` | Ignored on streaming path (no file is written); accepted for option compatibility |
| `maxRetry` | `number` | Effective on `BrowserAdapter` (segment prefetch retries). **Not effective on `NodeAdapter`** streaming path (the built-in reqwest client has no retry hook) |
| `downloadConcurrency` | `number` | Concurrent segment downloads |
| `signal` | `AbortSignal` | Cooperative cancellation. When the signal aborts, the stream rejects with an `AbortError`. On `BrowserAdapter`, abort during the prefetch phase is limited to `fetch`-level signal propagation |
| `variant` | `VariantSelectOptions` | Master-playlist variant selection preferences. Omit for default (highest resolution → bandwidth) |

Returns `{ totalSegments: number }`.

#### Example: HTTP server streaming to a browser (stream + persist)

```ts
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { HlsDownloader } from '@hls-downloader/core';
import { NodeAdapter } from '@hls-downloader/adapters/node';

const downloader = new HlsDownloader({ adapter: NodeAdapter });

const server = createServer(async (req, res) => {
  if (req.url !== '/stream.mp4') {
    res.writeHead(404);
    return res.end('not found');
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',   // fMP4 — browser MSE can parse
    'Cache-Control': 'no-cache',
    // No Content-Length — streaming, length unknown
  });

  // The library does not write to disk: bytes from onChunk go to both
  // the HTTP response and a buffer for later file write.
  const fileChunks: Uint8Array[] = [];
  await downloader.downloadToStream(
    {
      url: 'https://example.com/stream.m3u8',
      headers: { Authorization: 'Bearer ...' },
      downloadConcurrency: 8,
    },
    (bytes) => {
      res.write(bytes);            // stream as-you-go
      fileChunks.push(bytes);     // buffer for later file write
    },
  );
  res.end();

  // Write the file afterwards (or use ReadableStream.tee() to persist in parallel during the stream)
  await writeFile(
    'output.mp4',
    Buffer.concat(fileChunks.map((c) => Buffer.from(c))),
  );
});

server.listen(3000);
```

::: tip Recommended approach for stream + persist in parallel
If you want to persist the file in parallel during the stream (rather than after), wrap `onChunk` into a `ReadableStream`, then fork with `stream.tee()`:
- branch 1 → HTTP response (live playback)
- branch 2 → `Bun.write(filePath, branch)` or `pipeline(branch, createWriteStream(filePath))` (background file write)

`tee()` provides backpressure and ordering guarantees; the two branches consume independently. The file becomes available once the task completes.
:::

::: tip Resume not supported
The streaming path writes to a non-seekable sink, so `resume` is not supported. If the stream fails midway, restart from the beginning.
:::

### `getPosterUrl()`

```ts
async getPosterUrl(
  options: HlsDownloaderFetchOptions
): Promise<string | undefined>
```

Attempt to extract a poster/thumbnail image URL from the stream. Merges `options` with `globalOptions.download` (headers only). Returns the URL string if found, otherwise `undefined`.

**Does not load FFmpeg on `BrowserAdapter`.** On `NodeAdapter`, FFmpeg may load only if lightweight extraction fails — see [Adapter API](./adapters.md).

| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | HLS playlist URL |
| `headers` | `Record<string, string>` | Request headers |

### `clearCache()`

```ts
clearCache(): void
```

Invalidate the adapter's internal `parseHls` result cache. The next `parseHls()` call for any URL re-fetches from the network. No-op if the adapter has no cache.

## Variant selection

When `parseHls()` returns a master playlist, `download()` / `downloadToStream()` pick one variant via `selectBestVariant`. The default strategy:

1. Exclude audio-only variants (unless `includeAudioOnly`).
2. Exclude variants exceeding `maxResolution` / `maxBandwidth` (if set); fall back to the unfiltered list if all are excluded.
3. Score by `preferredCodec` → `preferredAudio` → resolution (pixels) → bandwidth, picking the highest.

Steer selection per-call with the `variant` option:

```ts
await downloader.download({
  url: 'https://example.com/master.m3u8',
  variant: {
    maxResolution: { width: 1280, height: 720 },
    preferredCodec: 'hvc1',
  },
});
```

See [VariantSelectOptions](./types.md#variantselectoptions) for the full option shape. `selectBestVariant` and the `VariantSelector` type are exported from `@hls-downloader/shared` for custom strategies.
