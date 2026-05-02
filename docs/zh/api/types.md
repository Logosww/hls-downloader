# 类型定义

所有类型从 `@hls-downloader/shared`（或 `@logosw/hls-downloader/shared`）导出。

## Segment

```ts
type Segment = {
  uri: string
  [key: string]: any
}
```

表示单个 HLS 分片，包含 URI 及播放列表中的其他属性。

## Playlist

```ts
type Playlist = {
  name: string
  bandwidth: number
  uri: string
}
```

表示主播放列表中的变体流。

## ParseHlsResult

```ts
type ParseHlsResult =
  | { type: 'playlist'; data: Playlist[]; message?: undefined }
  | { type: 'segment'; data: Segment[]; message?: undefined }
  | { type: 'error'; data?: undefined; message: string }
```

`parseHls()` 返回的可辨识联合类型：

- `playlist` — URL 指向包含变体流的主播放列表
- `segment` — URL 指向包含分片的媒体播放列表
- `error` — 解析失败，附带错误信息

## HlsDownloaderEvent

```ts
enum HlsDownloaderEvent {
  FFMPEG_LOADING = 'ffmpeg-loading',
  FFMPEG_LOADED = 'ffmpeg-loaded',
  STARTING_DOWNLOAD = 'starting-download',
  SOURCE_PARSED = 'source-parsed',
  DOWNLOADING = 'downloading',
  DOWNLOADING_SEGMENTS = 'downloading-segments',
  STICHING_SEGMENTS = 'stiching-segments',
  READY_FOR_DOWNLOAD = 'ready-for-download',
  ERROR = 'error',
}
```

## HlsDownloaderFetchOptions

```ts
type HlsDownloaderFetchOptions = {
  url: string
  headers?: Record<string, string>
}
```

对 HLS 源发起请求的基础选项。

## HlsDownloaderDownloadOptions

```ts
type HlsDownloaderDownloadOptions = {
  filename?: string
  maxRetry?: number
  downloadConcurrency?: number
}
```

`download()` 方法的额外选项。

## 下载结果（随适配器而异）

`HlsDownloader.download()` 成功时解析得到的字段由构造时传入的**适配器**决定。失败时 Promise **被拒绝**，不会解析为特殊占位值。

### WasmAdapter

```ts
type WasmAdapterDownloadResult = {
  blobURL: string
  totalSegments: number
}
```

`blobURL` 为浏览器对象 URL（`blob:...`），指向合并后的文件。

### RustAdapter

```ts
type RustAdapterDownloadResult = {
  filePath: string
  totalSegments: number
}
```

`filePath` 为磁盘上合并文件的**绝对路径**。

`@hls-downloader/shared` 中不导出单一的 `DownloadResult`；TypeScript 会根据 `HlsDownloader` 上的适配器类型推断具体字段。

