# HlsDownloader

The main facade class for downloading HLS streams. Imported from `@hls-downloader/core`.

::: info Default download path (transmux)
**Ordinary `download()` calls use a lightweight transmux/remux path and do not load or run FFmpeg.** Segments are merged while keeping the source codecs (e.g. into MP4).

FFmpeg is loaded **only on demand** when a code path actually needs it — see [Adapter API](./adapters.md) for adapter-specific triggers. `init()` and `parseHls()` never load FFmpeg.

To use FFmpeg for transcoding, pass a `transcode` options object with a `preset`, explicit output codecs, or `format` on `download()` (or set `globalOptions.transcode`). Omit `transcode` for the default transmux/remux path.
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

Initialize lightweight adapter state. **Does not load FFmpeg.** Calling `download()` automatically triggers `init()` if not yet initialized.

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

**By default (no `transcode`)**, adapters use the lightweight transmux path — **FFmpeg is not loaded**. Passing a `transcode` object with a `preset`, explicit output codecs, or `format` switches to the FFmpeg path.

Merges per-call options with `globalOptions` (per-call wins).

| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | HLS playlist URL |
| `headers` | `Record<string, string>` | Request headers |
| `filename` | `string` | Output filename without extension. The extension is resolved internally from the output container (`mp4` by default, `webm` for `vp9`, or `transcode.format`) |
| `maxRetry` | `number` | Max retry attempts per segment |
| `downloadConcurrency` | `number` | Concurrent segment downloads |
| `transcode` | `HlsDownloaderTranscodeOptions` | **Transcode with FFmpeg.** Omit for default transmux/remux (no FFmpeg) |
| `signal` | `AbortSignal` | Cooperative cancellation. When the signal aborts, the download promise rejects with an `AbortError` |
| *(adapter-specific)* | — | See [Adapter API](./adapters.md) |

When `transcode` is set on **BrowserAdapter**, only `{ preset: 'h264' }` is supported. On **NodeAdapter**, all fields below apply:

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
`downloadToStream()` is supported on both **`BrowserAdapter`** and **`NodeAdapter`**. On `BrowserAdapter`, the fMP4 bytes flow via `onChunk` and are well-suited for real-time MSE playback (e.g. `SourceBuffer.appendBuffer`).
:::

```ts
async downloadToStream(
  options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions,
  onChunk: (bytes: Uint8Array) => void,
): Promise<HlsDownloaderStreamResult>
```

Stream-as-you-go: parse HLS → Rust transmux → push fMP4 bytes via `onChunk` in real time. **The library itself does not write to disk** — bytes flow directly from the native transmuxer to the callback; whether to persist is up to the caller (e.g. fork one branch to a file with `ReadableStream.tee()` to get both "live stream" and "downloadable file afterwards"). Designed for HTTP servers forwarding the stream to a browser MSE player, or for in-browser MSE playback.

The first chunk arrives as soon as the first segment is processed; you do **not** wait for all segments to be downloaded. Backpressure is natural: if `onChunk` is slow, the native transmuxer awaits, slowing further downloads.

Output is **fragmented MP4** (first segment: `ftyp`+`moov`, each subsequent segment: `styp`+`moof`+`mdat`, optional trailing `mfra`). Browser MSE can consume it directly.

Merges per-call options with `globalOptions` (per-call wins).

| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | HLS playlist URL |
| `headers` | `Record<string, string>` | Request headers |
| `filename` | `string` | Ignored on streaming path (no file is written); accepted for option compatibility |
| `maxRetry` | `number` | Currently not effective on the streaming path (built-in reqwest has no retry hook) |
| `downloadConcurrency` | `number` | Concurrent segment downloads |
| `signal` | `AbortSignal` | Cooperative cancellation. When the signal aborts, the stream rejects with an `AbortError` |

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
