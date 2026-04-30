# HlsDownloader

The main facade class for downloading HLS streams. Imported from `@hls-downloader/core`.

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
| `adapter` | `WasmAdapter \| RustAdapter` | The adapter to use |
| `options` | `object` | Default fetch options (e.g. `headers`) plus adapter-specific options. Merged with each `parseHls` / `download` call |
| `onEvent` | `(event, payload?) => void` | Event callback for tracking progress and errors |

## Properties

### `isInit`

```ts
get isInit(): boolean
```

Whether the adapter has been initialized. Returns `true` after `init()` resolves.

## Methods

### `init()`

```ts
async init(): Promise<void>
```

Initialize the adapter. For the WASM adapter this loads FFmpeg; for the Rust adapter it prepares the native module. Must be called before `download()`. Calling `download()` automatically triggers `init()` if not yet initialized.

### `setOptions()`

```ts
setOptions(options): void
```

Update the default options (per-call `url` is not stored here). Accepts the same shape as the constructor `options`. Options set here are merged with each `parseHls` / `download` call.

### `parseHls()`

```ts
async parseHls(options: HlsDownloaderFetchOptions): Promise<ParseHlsResult>
```

Parse an HLS playlist without downloading segments. Returns a `ParseHlsResult`:

- `{ type: 'playlist', data: Playlist[] }` — master playlist with variant streams
- `{ type: 'segment', data: Segment[] }` — media playlist with segments
- `{ type: 'error', message: string }` — parse error

### `download()`

```ts
async download(
  options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions
): Promise<DownloadResult>
```

Parse, download all segments, and merge them into a single file. Returns `{ blobURL, totalSegments }` on success, or `void` on failure.

| Option | Type | Description |
|--------|------|-------------|
| `url` | `string` | HLS playlist URL |
| `headers` | `Record<string, string>` | Request headers |
| `filename` | `string` | Output filename |
| `maxRetry` | `number` | Max retry attempts per segment |
| `downloadConcurrency` | `number` | Concurrent segment downloads |

### `getPosterUrl()`

```ts
async getPosterUrl(
  options: HlsDownloaderFetchOptions
): Promise<string | undefined>
```

Attempt to extract a poster/thumbnail image URL from the stream. Returns the URL string if found, otherwise `undefined`.

