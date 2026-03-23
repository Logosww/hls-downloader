# Types

All types are exported from `@hls-downloader/shared` (or `hls-downloader/shared`).

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

## HlsDownloaderFetchOption

```ts
type HlsDownloaderFetchOption = {
  url: string
  headers?: Record<string, string>
}
```

Base options for any request to an HLS source.

## HlsDownloaderDownloadOption

```ts
type HlsDownloaderDownloadOption = {
  filename?: string
  maxRetry?: number
  downloadConcurrency?: number
}
```

Additional options specific to the `download()` method.

## DownloadResult

```ts
type DownloadResult = {
  blobURL: string
  totalSegments: number
} | void
```

Returned by `download()`. On success, contains the blob URL of the merged file and the total number of segments. Returns `void` on failure.

