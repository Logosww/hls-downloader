# Types

Types below are exported from `@hls-downloader/shared` unless noted.

## Segment

```ts
type Segment = {
  uri: string
  [key: string]: any
}
```

## Playlist

```ts
type Playlist = {
  name: string
  bandwidth: number
  uri: string
}
```

## ParseHlsResult

```ts
type ParseHlsResult =
  | { type: 'playlist'; data: Playlist[]; message?: undefined }
  | { type: 'segment'; data: Segment[]; message?: undefined }
  | { type: 'error'; data?: undefined; message: string }
```

## HlsDownloaderEvent

```ts
enum HlsDownloaderEvent {
  FFMPEG_LOADING = 'ffmpeg-loading',
  FFMPEG_LOADED = 'ffmpeg-loaded',
  STARTING_DOWNLOAD = 'starting-download',
  SOURCE_PARSED = 'source-parsed',
  DOWNLOADING = 'downloading',
  DOWNLOADING_SEGMENTS = 'downloading-segments',
  STITCHING_SEGMENTS = 'stitching-segments',
  READY_FOR_DOWNLOAD = 'ready-for-download',
  ERROR = 'error',
}
```

## HlsDownloaderFetchOptions

```ts
type HlsDownloaderFetchOptions = {
  url: string
  headers?: Record<string, string>
  signal?: AbortSignal
}
```

## HlsDownloaderGlobalDownloadOptions

```ts
type HlsDownloaderGlobalDownloadOptions = {
  headers?: Record<string, string>
  concurrency?: number
  maxRetry?: number
}
```

Used in `GlobalOptions.download` (from `@hls-downloader/core`).

## HlsDownloaderTranscodeOptions

```ts
type HlsDownloaderTranscodePreset = 'h264' | 'hevc' | 'vp9'

type HlsDownloaderEncoderSpeed =
  | 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast'
  | 'medium' | 'slow' | 'slower' | 'veryslow'

type HlsDownloaderTranscodeOptions = {
  preset?: HlsDownloaderTranscodePreset
  videoCodec?: string
  audioCodec?: string
  format?: string
  crf?: number
  videoBitrate?: string | number
  audioBitrate?: string | number
  speed?: HlsDownloaderEncoderSpeed
}
```

**Presets** (override with explicit codec/format fields):

| `preset` | Video | Audio | Container | BrowserAdapter |
|----------|-------|-------|-----------|----------------|
| `h264` | libx264 | aac | mp4 | Yes (`{ preset: 'h264' }` only) |
| `hevc` | libx265 | aac | mp4 | Node only |
| `vp9` | libvpx-vp9 | libopus | webm | Node only |

Omit `transcode` for default transmux/remux (no FFmpeg). `needsFfmpegTranscode()` returns true when a `preset` or `format` is set, or any output codec is not `copy`.

## HlsDownloaderBrowserTranscodeOptions

Browser FFmpeg.wasm only supports H.264 via preset — no fine-grained encoding fields.

```ts
type HlsDownloaderBrowserTranscodeOptions = {
  preset: 'h264'
}
```

Use with `BrowserAdapter` / `GlobalOptions<typeof BrowserAdapter>`. `hevc` and `vp9` require `NodeAdapter`.

## HlsDownloaderDownloadOptions

```ts
type HlsDownloaderDownloadOptions = {
  filename?: string
  maxRetry?: number
  downloadConcurrency?: number
  transcode?: HlsDownloaderTranscodeOptions
  signal?: AbortSignal
}
```

Per-call options for `download()`. `filename` is a plain filename without extension; the final extension is resolved internally from the output container (`mp4` by default, preset/format-aware when `transcode` is set). Pass `signal` (an `AbortSignal`) to cooperatively cancel an in-progress download; the download promise rejects with an `AbortError`.

## HlsDownloaderStreamResult

```ts
type HlsDownloaderStreamResult = {
  totalSegments: number
}
```

Resolution value of `HlsDownloader.downloadToStream()`. The library itself does not write to disk — fMP4 bytes are pushed via the `onChunk` callback; callers decide whether to persist (e.g. via `ReadableStream.tee()`), so only the segment count is returned. Both `BrowserAdapter` and `NodeAdapter` support this method.

## GlobalOptions

```ts
type GlobalOptions<T extends HlsDownloaderAdapter> = {
  download?: HlsDownloaderGlobalDownloadOptions
  transcode?: HlsDownloaderTranscodeOptions
} & AdapterSpecificOptions<T>
```

Exported from `@hls-downloader/core`. `AdapterSpecificOptions<T>` is inferred from the adapter type (see [Adapter API](./adapters.md)).

## Download result (adapter-specific)

`HlsDownloader.download()` resolves to a value whose shape depends on the adapter. On failure, the promise is **rejected**.

### BrowserAdapter

```ts
type BrowserAdapterDownloadResult = {
  blobURL: string
  totalSegments: number
}
```

### NodeAdapter

```ts
type NodeAdapterDownloadResult = {
  filePath: string
  totalSegments: number
}
```

TypeScript infers the correct result type from the adapter passed to `HlsDownloader`.
