# 类型定义

以下类型默认从 `@hls-downloader/shared` 导出，另有说明的除外。

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

用于 `@hls-downloader/core` 的 `GlobalOptions.download`。

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

**预设**（可用显式 codec/format 字段覆盖）：

| `preset` | 视频 | 音频 | 容器 | BrowserAdapter |
|----------|------|------|------|----------------|
| `h264` | libx264 | aac | mp4 | 支持（仅 `{ preset: 'h264' }`） |
| `hevc` | libx265 | aac | mp4 | 仅 Node |
| `vp9` | libvpx-vp9 | libopus | webm | 仅 Node |

省略 `transcode` 即默认 transmux/remux（不加载 FFmpeg）。`needsFfmpegTranscode()` 在设置了 `preset`、`format` 或任一输出编码非 `copy` 时返回 `true`。

## HlsDownloaderBrowserTranscodeOptions

浏览器 FFmpeg.wasm 仅支持 H.264 preset，不提供细粒度编码字段。

```ts
type HlsDownloaderBrowserTranscodeOptions = {
  preset: 'h264'
}
```

配合 `BrowserAdapter` / `GlobalOptions<typeof BrowserAdapter>` 使用。`hevc`、`vp9` 请用 `NodeAdapter`。

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

`download()` 单次调用选项。`filename` 是不含扩展名的单纯文件名；最终扩展名由内部根据输出容器解析（默认 `mp4`，设置 `transcode` 时感知 preset/format）。传入 `signal`（`AbortSignal`）可协作式取消正在进行的下载；取消时下载 Promise 会以 `AbortError` 拒绝。

## HlsDownloaderStreamResult

```ts
type HlsDownloaderStreamResult = {
  totalSegments: number
}
```

`HlsDownloader.downloadToStream()` 的返回值。库本身不落盘——fMP4 字节通过 `onChunk` 回调推送；是否落盘由调用方决定（如用 `ReadableStream.tee()` 分叉一路写文件），因此只返回分片总数。`BrowserAdapter` 与 `NodeAdapter` 均支持此方法。

## GlobalOptions

```ts
type GlobalOptions<T extends HlsDownloaderAdapter> = {
  download?: HlsDownloaderGlobalDownloadOptions
  transcode?: HlsDownloaderTranscodeOptions
} & AdapterSpecificOptions<T>
```

从 `@hls-downloader/core` 导出。`AdapterSpecificOptions<T>` 由适配器类型推断（见[适配器 API](./adapters.md)）。

## 下载结果（随适配器而异）

`HlsDownloader.download()` 成功时返回的字段由适配器决定。失败时 Promise **被拒绝**。

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

TypeScript 会根据传入 `HlsDownloader` 的适配器类型推断具体结果类型。
