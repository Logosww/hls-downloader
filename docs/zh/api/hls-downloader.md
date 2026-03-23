# HlsDownloader

用于下载 HLS 流的主门面类。从 `@hls-downloader/core` 导入。

## 构造函数

```ts
new HlsDownloader({
  adapter,
  option?,
  onEvent?,
})
```

| 参数 | 类型 | 描述 |
|------|------|------|
| `adapter` | `WasmAdapter \| RustAdapter` | 使用的适配器 |
| `option` | `object` | 默认请求选项（如 `headers`）+ 适配器专有选项，会与每次 `parseHls` / `download` 传入的选项合并 |
| `onEvent` | `(event, payload?) => void` | 事件回调，用于追踪进度和错误 |

## 属性

### `isInit`

```ts
get isInit(): boolean
```

适配器是否已初始化。`init()` 完成后返回 `true`。

## 方法

### `init()`

```ts
async init(): Promise<void>
```

初始化适配器。WASM 适配器会在此加载 FFmpeg；Rust 适配器会准备原生模块。必须在 `download()` 之前调用。`download()` 会在未初始化时自动触发 `init()`。

### `setOption()`

```ts
setOption(option): void
```

更新默认选项（单次请求的 `url` 不存储于此）。接受与构造函数 `option` 相同的结构。此处设置的选项会与每次 `parseHls` / `download` 调用合并。

### `parseHls()`

```ts
async parseHls(option: HlsDownloaderFetchOption): Promise<ParseHlsResult>
```

解析 HLS 播放列表，不下载分片。返回 `ParseHlsResult`：

- `{ type: 'playlist', data: Playlist[] }` — 主播放列表，包含变体流
- `{ type: 'segment', data: Segment[] }` — 媒体播放列表，包含分片
- `{ type: 'error', message: string }` — 解析错误

### `download()`

```ts
async download(
  option: HlsDownloaderFetchOption & HlsDownloaderDownloadOption
): Promise<DownloadResult>
```

解析、下载所有分片并合并为单个文件。成功返回 `{ blobURL, totalSegments }`，失败返回 `void`。

| 选项 | 类型 | 描述 |
|------|------|------|
| `url` | `string` | HLS 播放列表 URL |
| `headers` | `Record<string, string>` | 请求头 |
| `filename` | `string` | 输出文件名 |
| `maxRetry` | `number` | 每个分片最大重试次数 |
| `downloadConcurrency` | `number` | 并发下载分片数 |

### `getPosterUrl()`

```ts
async getPosterUrl(
  option: HlsDownloaderFetchOption
): Promise<string | undefined>
```

尝试从流中提取封面/缩略图 URL。找到时返回 URL 字符串，否则返回 `undefined`。

