# HlsDownloader

用于下载 HLS 流的主门面类。从 `@hls-downloader/core` 导入。

::: info 默认下载路径（Transmux）
**普通 `download()` 会保留源编码并 transmux 为 MP4。** BrowserAdapter 使用 [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly；NodeAdapter 使用原生 Rust 路径。

重编码通过 `transcode` 显式启用 — 见[适配器 API](./adapters.md)。BrowserAdapter 使用 Mediabunny 与 WebCodecs；NodeAdapter 按需加载原生 FFmpeg。`init()` 与 `parseHls()` 均不会启动这些引擎。
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

初始化轻量适配器状态。BrowserAdapter 与 NodeAdapter 仅在后续 API 需要时才启动其重量级引擎。`download()` 会在未初始化时自动触发 `init()`。

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

**默认（不传 `transcode`）** 各适配器走 transmux 路径并保留源编码。传入 `transcode` 后进入重编码：BrowserAdapter 使用 WebCodecs；NodeAdapter 使用 FFmpeg。

单次传入的选项与 `globalOptions` 合并，单次选项优先。

| 选项 | 类型 | 描述 |
|------|------|------|
| `url` | `string` | HLS 播放列表地址 |
| `headers` | `Record<string, string>` | 请求头 |
| `filename` | `string` | 不含扩展名的输出文件名。扩展名由内部根据输出容器解析（默认 `mp4`，`vp9` 为 `webm`，或取 `transcode.format`） |
| `maxRetry` | `number` | 每个分片的最大重试次数 |
| `downloadConcurrency` | `number` | 分片并发下载数 |
| `transcode` | `HlsDownloaderTranscodeOptions` | BrowserAdapter 使用 WebCodecs 转码，NodeAdapter 使用 FFmpeg。省略时默认 transmux/remux |
| `signal` | `AbortSignal` | 协作式取消。当信号中止时，下载 Promise 会被拒绝并抛出 `AbortError` |
| *（适配器专有）* | — | 见[适配器 API](./adapters.md) |

BrowserAdapter 支持 `preset`、`videoBitrate` 与 `audioBitrate`；NodeAdapter 支持下列全部字段：

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

#### 示例：使用 AbortController 中止下载

```ts
const controller = new AbortController();

// 5 秒后中止（例如用户点击了取消）
setTimeout(() => controller.abort(), 5000);

try {
  await downloader.download({
    url: 'https://example.com/stream.m3u8',
    filename: 'output',
    signal: controller.signal,
  });
} catch (err) {
  if (err.name === 'AbortError') {
    console.log('下载已中止');
  } else {
    throw err;
  }
}
```

### `downloadToStream()`

::: tip BrowserAdapter 与 NodeAdapter
`downloadToStream()` 在 **`BrowserAdapter`** 与 **`NodeAdapter`** 上均已实现。在 `BrowserAdapter` 上，fMP4 字节通过 `onChunk` 推送，适合实时 MSE 播放（例如 `SourceBuffer.appendBuffer`）。
:::

```ts
async downloadToStream(
  options: HlsDownloaderFetchOptions & HlsDownloaderDownloadOptions,
  onChunk: (bytes: Uint8Array) => void,
): Promise<HlsDownloaderStreamResult>
```

解析 HLS，经 Rust transmux 后通过 `onChunk` 推送 fMP4 字节。**库本身不落盘。** BrowserAdapter 先以有界并发预取播放列表资源，再由 WASM writer 输出分块；NodeAdapter 可并发下载并同步推流。

输出为 **fragmented MP4**（首段 `ftyp`+`moov`，之后每段 `styp`+`moof`+`mdat`，末端可选 `mfra`）。浏览器 MSE 可直接消费。

单次传入的选项与 `globalOptions` 合并，单次选项优先。

| 选项 | 类型 | 描述 |
|------|------|------|
| `url` | `string` | HLS 播放列表地址 |
| `headers` | `Record<string, string>` | 请求头 |
| `filename` | `string` | 流式路径不写文件，此字段被忽略；为选项兼容性而保留 |
| `maxRetry` | `number` | 当前在流式路径下不生效（内置 reqwest 无重试钩子） |
| `downloadConcurrency` | `number` | 分片并发下载数 |
| `signal` | `AbortSignal` | 协作式取消。当信号中止时，流式 Promise 会被拒绝并抛出 `AbortError` |

返回 `{ totalSegments: number }`。

#### 示例：HTTP 服务推流给浏览器（边推流 + 边落盘）

```ts
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { HlsDownloader } from '@hls-downloader/core';
import { NodeAdapter } from '@hls-downloader/adapters/node';

const downloader = new HlsDownloader({ adapter: NodeAdapter });

const server = createServer(async (req, res) => {
  if (req.url !== '/stream.mp4') {
    res.writeHead(404);
    return res.end('not found');
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',   // fMP4，浏览器 MSE 可解析
    'Cache-Control': 'no-cache',
    // 不设 Content-Length —— 流式，长度未知
  });

  // 库本身不落盘：onChunk 拿到的字节同时写入 HTTP response 与文件
  const fileChunks: Uint8Array[] = [];
  await downloader.downloadToStream(
    {
      url: 'https://example.com/stream.m3u8',
      headers: { Authorization: 'Bearer ...' },
      downloadConcurrency: 8,
    },
    (bytes) => {
      res.write(bytes);            // 边推流
      fileChunks.push(bytes);     // 边缓冲（事后写文件）
    },
  );
  res.end();

  // 事后写文件（也可用 ReadableStream.tee() 在流过程中并行落盘）
  await writeFile(
    'output.mp4',
    Buffer.concat(fileChunks.map((c) => Buffer.from(c))),
  );
});

server.listen(3000);
```

::: tip 边推流 + 边落盘的推荐做法
若希望流过程中并行落盘（而非事后写），可把 `onChunk` 包装成 `ReadableStream`，再用 `stream.tee()` 分叉：
- branch 1 → HTTP response（实时播放）
- branch 2 → `Bun.write(filePath, branch)` 或 `pipeline(branch, createWriteStream(filePath))`（后台落盘）

`tee()` 内置背压与顺序保证，两个 branch 独立消费。task 完成后文件即可访问。
:::

::: tip 不支持 resume
流式路径写入的是不可 seek 的 sink，因此不支持 resume。若中途失败，需从头开始。
:::

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
