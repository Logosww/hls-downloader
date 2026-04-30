# HlsDownloader

用于下载 HLS 流的主门面类。从 `@hls-downloader/core` 导入。

## 构造函数

```ts
new HlsDownloader({
  adapter,
  options?,
  onEvent?,
})
```

| 参数 | 类型 | 描述 |
|------|------|------|
| `adapter` | `WasmAdapter \| RustAdapter` | 使用的适配器 |
| `options` | `object` | 默认请求选项（如 `headers`）+ 适配器专有选项，会与每次 `parseHls` / `download` 传入的选项合并 |
| `onEvent` | `(event, payload?) => void` | 事件回调，用于追踪进度和错误 |

## 属性

### `isInit`

```ts
get isInit(): boolean
```

适配器是否已完成初始化。`init()` 成功后为 `true`。

## 方法

### `init()`

```ts
async init(): Promise<void>
```

初始化适配器。WASM 适配器会在此加载 FFmpeg；Rust 适配器会准备原生模块。必须在 `download()` 之前调用。`download()` 会在未初始化时自动触发 `init()`。

### `setOptions()`

```ts
setOptions(options): void
```

更新默认选项（单次请求的 `url` 不存储于此）。接受与构造函数 `options` 相同的结构。此处设置的选项会与每次 `parseHls` / `download` 调用合并。

### `parseHls()`

```ts
async parseHls(options: HlsDownloaderFetchOptions): Promise<ParseHlsResult>
```

仅解析 HLS 播放列表，不下载分片。返回 `ParseHlsResult`：

- `{ type: 'playlist', data: Playlist[] }` — 主列表及变体流
- `{ type: 'segment', data: Segment[] }` — 媒体列表及分片
- `{ type: 'error', message: string }` — 解析错误

### `download()`

```ts
async download(
  options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions
): Promise<DownloadResult>
```

解析、下载全部分片并合并为单个文件。成功时返回 `{ blobURL, totalSegments }`，失败时返回 `void`。

| 选项 | 类型 | 描述 |
|------|------|------|
| `url` | `string` | HLS 播放列表地址 |
| `headers` | `Record<string, string>` | 请求头 |
| `filename` | `string` | 输出文件名 |
| `maxRetry` | `number` | 每个分片的最大重试次数 |
| `downloadConcurrency` | `number` | 分片并发下载数 |

### `getPosterUrl()`

```ts
async getPosterUrl(
  options: HlsDownloaderFetchOptions
): Promise<string | undefined>
```

尝试从流中提取封面/缩略图 URL；若存在则返回 URL 字符串，否则 `undefined`。

