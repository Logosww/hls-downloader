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
