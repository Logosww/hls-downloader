# Types

All types are exported from `@hls-downloader/shared` (or `@logosw/hls-downloader/shared`).

## Segment

```ts
type Segment = {
  uri: string
  [key: string]: any
}
```

Represents a single HLS segment with a URI and any additional properties from the playlist.

## Playlist

```ts
type Playlist = {
  name: string
  bandwidth: number
  uri: string
}
```

Represents a variant stream in a master playlist.

## ParseHlsResult

```ts
type ParseHlsResult =
  | { type: 'playlist'; data: Playlist[]; message?: undefined }
  | { type: 'segment'; data: Segment[]; message?: undefined }
  | { type: 'error'; data?: undefined; message: string }
```

Discriminated union returned by `parseHls()`:

- `playlist` — the URL pointed to a master playlist containing variant streams
- `segment` — the URL pointed to a media playlist containing segments
- `error` — parsing failed with a message

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

Base options for any request to an HLS source.

## HlsDownloaderDownloadOptions

```ts
type HlsDownloaderDownloadOptions = {
  filename?: string
  maxRetry?: number
  downloadConcurrency?: number
}
```

Additional options specific to the `download()` method.

## Download result (adapter-specific)

`HlsDownloader.download()` resolves to a value whose shape depends on the adapter passed to the constructor. On failure, the returned promise is **rejected** (it does not resolve to a sentinel value).

### WasmAdapter

```ts
type WasmAdapterDownloadResult = {
  blobURL: string
  totalSegments: number
}
```

`blobURL` is a browser object URL (`blob:...`) for the merged file.

### RustAdapter

```ts
type RustAdapterDownloadResult = {
  filePath: string
  totalSegments: number
}
```

`filePath` is an absolute path to the merged file on disk.

There is no single exported `DownloadResult` in `@hls-downloader/shared`; TypeScript infers the correct fields from the adapter type on `HlsDownloader`.

