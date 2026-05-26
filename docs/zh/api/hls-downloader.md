# HlsDownloader

用于下载 HLS 流的主门面类。从 `@hls-downloader/core` 导入。

::: info 默认下载路径（Transmux）
**普通 `download()` 走轻量 transmux/remux 路径，不会加载或使用 FFmpeg。** 分片在保留源编码的前提下合并（例如输出 MP4）。

FFmpeg **仅在按需**、且某条代码路径确实需要时才会加载 — 各适配器的具体触发条件见[适配器 API](./adapters.md)。`init()` 与 `parseHls()` 均不会加载 FFmpeg。

若需通过 FFmpeg 转码，请在 `download()` 上传入带 `preset` 或显式输出编码的 `transcode` 选项（也可在 `globalOptions.transcode` 中设置）。省略 `transcode` 则走默认 transmux/remux 路径。
:::

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
| `adapter` | `BrowserAdapter \| NodeAdapter` | 使用的适配器 |
| `options` | `GlobalOptions<T>` | 默认选项（见下文），会与每次 `parseHls` / `download` / `getPosterUrl` 合并 |
| `onEvent` | `(event, payload?) => void` | 事件回调，用于追踪进度和错误 |

## 属性

### `isInit`

```ts
get isInit(): boolean
```

适配器是否已完成初始化。`init()` 成功后为 `true`。

### `globalOptions`

```ts
get globalOptions(): GlobalOptions<T> | null
```

当前默认选项；未设置时为 `null`。

## GlobalOptions

从 `@hls-downloader/core` 导出为 `GlobalOptions<T>`，具体字段随适配器类型 `T` 变化。

| 字段 | 类型 | 描述 |
|------|------|------|
| `download` | `HlsDownloaderGlobalDownloadOptions` | 默认请求 / 下载相关选项（不含单次 `url`） |
| `transcode` | `HlsDownloaderTranscodeOptions` | 默认转码选项 |
| *（适配器专有）* | — | 见[适配器 API](./adapters.md) |

### `download` 对象

| 字段 | 类型 | 描述 |
|------|------|------|
| `headers` | `Record<string, string>` | 默认请求头 |
| `concurrency` | `number` | 默认分片并发下载数 |
| `maxRetry` | `number` | 默认每个分片最大重试次数 |

单次调用 `download({ downloadConcurrency })` 会覆盖 `download.concurrency`。

## 方法

### `init()`

```ts
async init(): Promise<void>
```

初始化轻量适配器状态，**不会加载 FFmpeg**。`download()` 会在未初始化时自动触发 `init()`。

### `setOptions()`

```ts
setOptions(options: GlobalOptions<T>): void
```

更新默认选项，结构与构造函数 `options` 相同。

### `parseHls()`

```ts
async parseHls(options: HlsDownloaderFetchOptions): Promise<ParseHlsResult>
```

仅解析 HLS 播放列表，不下载分片。会将 `options` 与 `globalOptions.download` 合并（仅 `headers`）。

返回 `ParseHlsResult`：

- `{ type: 'playlist', data: Playlist[] }` — 主列表及变体流
- `{ type: 'segment', data: Segment[] }` — 媒体列表及分片
- `{ type: 'error', message: string }` — 解析错误

| 选项 | 类型 | 描述 |
|------|------|------|
| `url` | `string` | HLS 播放列表地址 |
| `headers` | `Record<string, string>` | 请求头 |

### `download()`

```ts
async download(
  options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions & Partial<AdapterOptions>
): Promise<DownloadResult>
```

解析、下载全部分片并合并为单个文件。成功时：**`BrowserAdapter`** 解析为 `{ blobURL, totalSegments }`；**`NodeAdapter`** 解析为 `{ filePath, totalSegments }`。失败时 Promise 被拒绝。

**默认（不传 `transcode`）** 各适配器走轻量 transmux 路径 — **不会加载 FFmpeg**。传入带 `preset` 或显式输出编码的 `transcode` 对象后切换为 FFmpeg 路径。

单次传入的选项与 `globalOptions` 合并，单次选项优先。

| 选项 | 类型 | 描述 |
|------|------|------|
| `url` | `string` | HLS 播放列表地址 |
| `headers` | `Record<string, string>` | 请求头 |
| `filename` | `string` | 输出文件名 |
| `maxRetry` | `number` | 每个分片的最大重试次数 |
| `downloadConcurrency` | `number` | 分片并发下载数 |
| `transcode` | `HlsDownloaderTranscodeOptions` | **FFmpeg 转码。** 省略时默认 transmux/remux（不加载 FFmpeg） |
| *（适配器专有）* | — | 见[适配器 API](./adapters.md) |

设置 `transcode` 时：**BrowserAdapter** 仅支持 `{ preset: 'h264' }`；**NodeAdapter** 支持下列全部字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `preset` | `'h264' \| 'hevc' \| 'vp9'` | 编码预设 |
| `videoCodec` | `string` | 覆盖预设视频编码 |
| `audioCodec` | `string` | 覆盖预设音频编码 |
| `format` | `string` | 输出容器（`-f`） |
| `crf` | `number` | 质量（x264/x265/vp9） |
| `videoBitrate` | `string \| number` | 视频码率 |
| `audioBitrate` | `string \| number` | 音频码率 |
| `speed` | `HlsDownloaderEncoderSpeed` | x264/x265 编码速度 |

### `getPosterUrl()`

```ts
async getPosterUrl(
  options: HlsDownloaderFetchOptions
): Promise<string | undefined>
```

尝试从流中提取封面/缩略图 URL。会将 `options` 与 `globalOptions.download` 合并（仅 `headers`）。若存在则返回 URL 字符串，否则 `undefined`。

**`BrowserAdapter` 不会为此加载 FFmpeg。** `NodeAdapter` 仅在轻量提取失败时可能加载 — 见[适配器 API](./adapters.md)。

| 选项 | 类型 | 描述 |
|------|------|------|
| `url` | `string` | HLS 播放列表地址 |
| `headers` | `Record<string, string>` | 请求头 |
