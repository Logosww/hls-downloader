# HLS Downloader

[![logosww/hls-downloader, explained in a one-minute video](https://gitdiagram.com/api/video/file?username=logosww&repo=hls-downloader&format=poster)](https://gitdiagram.com/logosww/hls-downloader/video)

随时随地下载你喜爱的任何 HLS 视频流。Downloads HLS stream whatever and wherever you want.

[![npm version](https://img.shields.io/npm/v/@logosw/hls-downloader?style=flat-square&logo=npm&label=npm)](https://www.npmjs.com/package/@logosw/hls-downloader)
[![npm downloads](https://img.shields.io/npm/dm/@logosw/hls-downloader?style=flat-square&logo=npm&label=downloads)](https://www.npmjs.com/package/@logosw/hls-downloader)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-Logosww%2Fhls--downloader-181717?style=flat-square&logo=github)](https://github.com/Logosww/hls-downloader)

---

用于解析 HLS（`.m3u8`）并下载、合并为可播放文件的 TypeScript 库。通过 `**HlsDownloader**` 统一入口，按运行环境选择适配器：

- **浏览器**：`@hls-downloader/adapters/browser`（`hls-transmux` WebAssembly + Mediabunny WebCodecs）
- **Node.js**：`@hls-downloader/adapters/node`（Rust N-API 原生实现，性能与路径处理更适合服务端）

### 安装

**方式一：聚合包 `@logosw/hls-downloader`（推荐）** — 一次安装即可使用与 `@hls-downloader/`* 相同的 API，子路径与独立子包一一对应：

```bash
pnpm add @logosw/hls-downloader
```

**方式二：按需安装子包**（减小依赖面或只引用部分能力时）：

```bash
pnpm add @hls-downloader/core @hls-downloader/shared
# 按需二选一（通常与运行环境一致）
pnpm add @hls-downloader/adapters   # 再通过子路径导入 browser 或 node，见下文
```

`@logosw/hls-downloader` 依赖 `@hls-downloader/core`、`@hls-downloader/shared`、`@hls-downloader/adapters`；`@hls-downloader/core` 已依赖 `@hls-downloader/shared`。使用适配器时（聚合包或独立安装）均需能解析到 `@hls-downloader/adapters` 中的 browser/node 实现。

**运行环境**：Node.js **≥ 20**（与 `core` 及聚合包根 `engines` 一致）。Node 适配器在 Node 下会加载 **原生 `.node` 模块**，需使用与你平台、Node ABI 匹配的发布产物；若在浏览器打包，请只打包 **browser** 子路径，不要把 Node 原生模块打进前端。

### 基本用法

```ts
// 也可：import { HlsDownloader, HlsDownloaderEvent, BrowserAdapter } from '@logosw/hls-downloader';
import { HlsDownloader } from '@hls-downloader/core';
import { HlsDownloaderEvent } from '@hls-downloader/shared';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';

const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  options: {
    // 可选：与适配器相关的额外选项，见下文
  },
  onEvent: (event, progress) => {
    if (
      event === HlsDownloaderEvent.DOWNLOADING_SEGMENTS ||
      event === HlsDownloaderEvent.STITCHING_SEGMENTS
    ) {
      console.log(progress?.completed, '/', progress?.total);
    }
  },
});

// 下载前可显式 init；WASM / WebCodecs / 原生 FFmpeg 均按需启动，不会在 init 阶段加载
await downloader.init();

// 仅解析主/子 playlist，不下载分片
const parsed = await downloader.parseHls({
  url: 'https://example.com/master.m3u8',
  headers: { Authorization: 'Bearer ...' },
});

// 解析并下载合并（filename 等见类型 HlsDownloaderDownloadOptions）
const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  headers: {},
  filename: 'output',
});

if (result) {
  // BrowserAdapter：result.blobURL 多为 blob: URL，可用于 <a download>
  // NodeAdapter：result.filePath 为合并文件的绝对路径
  console.log(result.totalSegments);
}

// 尝试从流中取封面图 URL（若有）
const poster = await downloader.getPosterUrl({ url: '...' });
```

Node 侧将 `BrowserAdapter` 换成 `NodeAdapter` 即可，构造方式相同：

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node';

const downloader = new HlsDownloader({ adapter: NodeAdapter, onEvent: ... });
await downloader.init();
```

### 边下边推流（BrowserAdapter 与 NodeAdapter）

`downloadToStream()` 通过 `onChunk` 输出 fMP4，适合 HTTP 转发或浏览器 MSE。两端均边下载边输出；`onChunk` 不等待 Promise，异步目标背压请使用 `downloadToWritable()`。**库本身不落盘**。

带初始音视频偏移的外置音轨合流，已验证文件/Blob 播放。Chromium MSE 会忽略前置空 edit；接入 MSE 时，播放端必须分别映射各轨道时间戳，不能将这些合流字节原样追加到单个 SourceBuffer。SDK 不提供该 MSE 映射。

```ts
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { HlsDownloader } from '@hls-downloader/core';
import { NodeAdapter } from '@hls-downloader/adapters/node';

const downloader = new HlsDownloader({ adapter: NodeAdapter });

// 场景：HTTP 服务把 fMP4 字节流转发给浏览器（边下边播）
const server = createServer(async (req, res) => {
  if (req.url !== '/stream.mp4') {
    res.writeHead(404);
    return res.end('not found');
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4', // fMP4，浏览器 MSE 可解析
    'Cache-Control': 'no-cache',
    // 注意：不设 Content-Length（流式，长度未知）
  });

  const controller = new AbortController();
  res.once('close', () => controller.abort());
  try {
    await downloader.downloadToWritable(
      {
        url: 'https://example.com/stream.m3u8',
        headers: { Authorization: 'Bearer ...' },
        downloadConcurrency: 8,
        signal: controller.signal,
      },
      Writable.toWeb(res), // 等待 HTTP 输出背压，成功后由库关闭响应
    );
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});

server.listen(3000);
```

要点：

- 输出为 **fragmented MP4**（首段 `ftyp`+`moov`，每段 `styp`+`moof`+`mdat`），接入 MSE 时需遵守下述音轨时间戳限制
- BrowserAdapter 与 NodeAdapter 均增量读取；异步输出使用 writable 等待背压
- 库本身不落盘；调用方可通过 `ReadableStream.tee()` 分叉一路写文件实现「边推流 + 边落盘」
- `download()` 文件路径完全不受影响，作为非流式 fallback

示例应用沿用这些接口：Web 保留 master URL，并通过 `variant` 传递清晰度偏好，以解析关联的默认音轨；MSE 预览等待每次写入完成。Bun 的 `/download` 接受可选 `variant` 和 `audio`，流式任务等待 HTTP 消费和文件写入；`POST /subtitles` 接受 `url`、`headers`、`variant`、`audio` 和必填 `subtitle: { groupId, name }`，返回独立 WebVTT 导出结果。

### `HlsDownloader` API 摘要

| 成员                                                                                                  | 说明                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `constructor({ adapter, options?, onEvent? })`                                                        | `options` 为 `GlobalOptions<T>`：`download`、`transcode` 及适配器专有字段，会与每次调用合并                                                                              |
| `init()`                                                                                              | 初始化轻量适配器状态；BrowserAdapter 的 WASM 与 WebCodecs 路径均按需启动                                                                                                 |
| `isInit`                                                                                              | 是否已完成初始化                                                                                                                                                         |
| `globalOptions`                                                                                       | 当前默认选项，未设置时为 `null`                                                                                                                                          |
| `setOptions(options)`                                                                                 | 更新默认选项                                                                                                                                                             |
| `parseHls({ url, headers? })`                                                                         | 返回 `ParseHlsResult`：主列表 `playlist`、媒体列表 `segment` 或 `error`                                                                                                  |
| `download({ url, headers?, filename?, maxRetry?, downloadConcurrency?, operationId?, signal?, ... })` | 下载并合并；`operationId` 可由调用方指定，缺省时自动生成。Browser 返回 `{ blobURL, totalSegments, operationId }`，Node 返回 `{ filePath, totalSegments, operationId }`。 |
| `downloadToStream({ url, headers?, operationId?, signal?, ... }, onChunk)`                            | **BrowserAdapter 与 NodeAdapter。** 输出 fMP4 字节，返回 `{ totalSegments, operationId }`。                                                                              |
| `getPosterUrl({ url, headers? })`                                                                     | 返回封面 URL 字符串，若无则 `undefined`                                                                                                                                  |

`GlobalOptions.download` 字段：`headers`、`concurrency`、`maxRetry`。`maxRetry` 表示包含首次请求在内的最大总尝试次数；网络错误、408、425、429 和 5xx 会指数退避重试，其他 4xx 直接失败。

### 事件 `HlsDownloaderEvent`

包括但不限于：`STARTING_DOWNLOAD`、`SOURCE_PARSED`、`DOWNLOADING`、`DOWNLOADING_SEGMENTS`、`STITCHING_SEGMENTS`、`READY_FOR_DOWNLOAD`、`ERROR`。所有下载事件 payload 均含 `operationId`；进度事件另含 `{ total, completed }`，`ERROR` 另含结构化 `HlsDownloaderError`。取消错误继续满足 `name === 'AbortError'`。

### Adapter 能力矩阵

可通过 `downloader.capabilities` 在运行时读取同一数据。

| 能力                | Browser         | Node            |
| ------------------- | --------------- | --------------- |
| 下载 / fMP4 stream  | 是 / 是         | 是 / 是         |
| 可配置重试          | 是              | 是              |
| Transcode presets   | h264、hevc、vp9 | h264、hevc、vp9 |
| Byte range          | 是              | 是              |
| AES-128（有限 VOD） | 是 | 是 |
| 持久输出            | 否（Blob URL）  | 是（文件路径）  |
| `writableOutput`    | true            | true            |
| `resumableDownload` | false           | true            |
| Live recording      | 是              | 是              |

### NodeAdapter 专有选项

| 字段    | 类型     |
| ------- | -------- |
| `aria2` | `object` |

`aria2` 字段见文档 [Adapter API](docs/api/adapters.md)。

### 类型与扩展

高级用法可从 `@hls-downloader/shared` 引用 `ParseHlsResult`、`HlsDownloaderFetchOptions`、`HlsDownloaderDownloadOptions`、`HlsDownloaderGlobalDownloadOptions`、`Playlist`、`Segment` 等；从 `@hls-downloader/core` 引用 `GlobalOptions`。

### 合规

请仅处理您有权访问的流地址，并遵守来源站点条款与适用法律。

### 许可证

[MIT](LICENSE)。

---

A TypeScript library for parsing HLS (`.m3u8`) playlists and downloading/merging streams into playable files. Use the `**HlsDownloader**` facade and pick an adapter for your runtime:

- **Browser**: `@hls-downloader/adapters/browser` (`hls-transmux` WebAssembly + Mediabunny WebCodecs)
- **Node.js**: `@hls-downloader/adapters/node` (Rust N-API; better fit for servers and path handling)

### Installation

**Option A — umbrella package `@logosw/hls-downloader` (recommended):** one install exposes the same APIs as the scoped packages, with subpaths mirroring `@hls-downloader/`*:

```bash
pnpm add @logosw/hls-downloader
```

**Option B — granular packages** (smaller install surface):

```bash
pnpm add @hls-downloader/core @hls-downloader/shared
pnpm add @hls-downloader/adapters
```

The `@logosw/hls-downloader` package depends on `@hls-downloader/core`, `@hls-downloader/shared`, and `@hls-downloader/adapters`. `@hls-downloader/core` depends on `@hls-downloader/shared`. For adapters, the browser/node implementations must resolve (via the umbrella or explicit `@hls-downloader/adapters`).

**Runtime**: Node.js **≥ 20** (matches `engines` on `core` and the root package). The Node adapter loads a **native `.node` addon** on Node—use a build that matches your platform and Node ABI. For browser bundles, only include the **browser** subpath; do not bundle the Node native addon into frontend code.

### Packages and subpaths

| Package / entry                                              | Role                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `@logosw/hls-downloader`                                     | Umbrella: default export `HlsDownloader`, re-exports `shared`, Browser/Node adapters (same as installing scoped packages) |
| `@logosw/hls-downloader/core`                                | Same as `@hls-downloader/core`                                                                                            |
| `@logosw/hls-downloader/shared`                              | Same as `@hls-downloader/shared`                                                                                          |
| `@logosw/hls-downloader/adapters`, `.../browser`, `.../node` | Same as `@hls-downloader/adapters` and subpaths                                                                           |
| `@hls-downloader/core`                                       | `HlsDownloader` class                                                                                                     |
| `@hls-downloader/shared`                                     | Types, `HlsDownloaderEvent`, `createAdapter`, etc. (pulled in via core/adapters)                                          |
| `@hls-downloader/adapters/browser`                           | Browser adapter `BrowserAdapter`                                                                                          |
| `@hls-downloader/adapters/node`                              | Node adapter `NodeAdapter`                                                                                                |

### Basic usage

```ts
// Or: import { HlsDownloader, HlsDownloaderEvent, BrowserAdapter } from '@logosw/hls-downloader';
import { HlsDownloader } from '@hls-downloader/core';
import { HlsDownloaderEvent } from '@hls-downloader/shared';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';

const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  options: {
    // Optional: adapter-specific options (see below)
  },
  onEvent: (event, progress) => {
    if (
      event === HlsDownloaderEvent.DOWNLOADING_SEGMENTS ||
      event === HlsDownloaderEvent.STITCHING_SEGMENTS
    ) {
      console.log(progress?.completed, '/', progress?.total);
    }
  },
});

// You may call init before download; WASM / WebCodecs / native FFmpeg start on demand, not during init
await downloader.init();

// Parse master/media playlist only; does not fetch segments
const parsed = await downloader.parseHls({
  url: 'https://example.com/master.m3u8',
  headers: { Authorization: 'Bearer ...' },
});

// Parse, fetch, and merge (filename etc.: see HlsDownloaderDownloadOptions)
const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  headers: {},
  filename: 'output',
});

if (result) {
  // BrowserAdapter: result.blobURL — often a blob: URL; use with <a download>
  // NodeAdapter: result.filePath — absolute path to the merged file
  console.log(result.totalSegments);
}

// Try to get a poster image URL from the stream, if present
const poster = await downloader.getPosterUrl({ url: '...' });
```

On Node, swap `BrowserAdapter` for `NodeAdapter`; construction is the same:

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node';

const downloader = new HlsDownloader({ adapter: NodeAdapter, onEvent: ... });
await downloader.init();
```

### Stream-as-you-go (BrowserAdapter & NodeAdapter)

`downloadToStream()` emits fMP4 through `onChunk` for HTTP forwarding or browser MSE. Both adapters download and emit incrementally. `onChunk` does not await promises; use writable output for asynchronous destination backpressure. **The library itself does not write to disk.**

External-audio output with initial track offsets is verified for file/Blob playback. Chromium MSE ignores leading empty edits; an MSE host must map timestamps per track instead of appending these multiplexed bytes unchanged to one SourceBuffer. The SDK does not provide that MSE mapping.

```ts
import { createServer } from 'node:http';
import { HlsDownloader } from '@hls-downloader/core';
import { NodeAdapter } from '@hls-downloader/adapters/node';

const downloader = new HlsDownloader({ adapter: NodeAdapter });

// Example: HTTP server pipes fMP4 bytes to a browser (streaming playback).
// Optionally fork one branch to a file with ReadableStream.tee() so the
// file is also available after the stream finishes.
const server = createServer(async (req, res) => {
  if (req.url !== '/stream.mp4') {
    res.writeHead(404);
    return res.end('not found');
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4', // fMP4 — browser MSE can parse
    'Cache-Control': 'no-cache',
    // Note: no Content-Length (streaming, length unknown)
  });

  await downloader.downloadToStream(
    {
      url: 'https://example.com/stream.m3u8',
      headers: { Authorization: 'Bearer ...' },
      downloadConcurrency: 8,
    },
    (bytes) => {
      res.write(bytes); // each chunk goes straight to the HTTP response body
    },
  );
  res.end();
});

server.listen(3000);
```

Notes:

- Output is **fragmented MP4** (first segment: `ftyp`+`moov`, each segment: `styp`+`moof`+`mdat`) — MSE hosts must follow the track-timestamp requirements below
- This NodeAdapter example starts emitting after the first segment; BrowserAdapter prefetches resources first
- The library does not write to disk; callers can fork a file-writing branch with `ReadableStream.tee()` for "stream + persist"
- The `download()` file path is unaffected; it remains the non-streaming fallback

### `HlsDownloader` API overview

| Member                                                                                                | Description                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constructor({ adapter, options?, onEvent? })`                                                        | `options` is `GlobalOptions<T>`: `download`, `transcode`, and adapter-specific fields; merged into each call                                                                                         |
| `init()`                                                                                              | Initialize lightweight adapter state; BrowserAdapter starts its WASM and WebCodecs paths on demand                                                                                                   |
| `isInit`                                                                                              | Whether initialization finished                                                                                                                                                                      |
| `globalOptions`                                                                                       | Current default options, or `null` if unset                                                                                                                                                          |
| `setOptions(options)`                                                                                 | Replace default options                                                                                                                                                                              |
| `parseHls({ url, headers? })`                                                                         | Returns `ParseHlsResult`: `playlist`, `segment`, or `error`                                                                                                                                          |
| `download({ url, headers?, filename?, maxRetry?, downloadConcurrency?, operationId?, signal?, ... })` | Download and merge. `operationId` may be supplied or is generated automatically. Browser returns `{ blobURL, totalSegments, operationId }`; Node returns `{ filePath, totalSegments, operationId }`. |
| `downloadToStream({ url, headers?, operationId?, signal?, ... }, onChunk)`                            | **BrowserAdapter & NodeAdapter.** Emits fMP4 bytes and returns `{ totalSegments, operationId }`.                                                                                                     |
| `getPosterUrl({ url, headers? })`                                                                     | Poster URL string, or `undefined`                                                                                                                                                                    |

`GlobalOptions.download` fields: `headers`, `concurrency`, `maxRetry`. `maxRetry` is the total number of attempts including the first request. Network errors, 408, 425, 429, and 5xx responses use exponential backoff; other 4xx responses fail immediately.

### `HlsDownloaderEvent` values

Includes (not limited to): `STARTING_DOWNLOAD`, `SOURCE_PARSED`, `DOWNLOADING`, `DOWNLOADING_SEGMENTS`, `STITCHING_SEGMENTS`, `READY_FOR_DOWNLOAD`, and `ERROR`. Every download payload includes `operationId`; progress events also include `{ total, completed }`, and `ERROR` includes a structured `HlsDownloaderError`.

### Adapter capability matrix

The same data is available at runtime through `downloader.capabilities`.

| Capability             | Browser         | Node            |
| ---------------------- | --------------- | --------------- |
| Download / fMP4 stream | yes / yes       | yes / yes       |
| Configurable retry     | yes             | yes             |
| Transcode presets      | h264, hevc, vp9 | h264, hevc, vp9 |
| Byte range             | yes             | yes             |
| AES-128 (finite VOD) | yes | yes |
| Persistent output      | no (Blob URL)   | yes (file path) |
| `writableOutput`       | true            | true            |
| `resumableDownload`    | false           | true            |
| Live recording         | yes              | yes              |

### NodeAdapter options

| Field   | Type     |
| ------- | -------- |
| `aria2` | `object` |

See [Adapter API](docs/api/adapters.md) for `aria2` fields.

### Types and extensions

Import `ParseHlsResult`, `HlsDownloaderFetchOptions`, `HlsDownloaderDownloadOptions`, `HlsDownloaderGlobalDownloadOptions`, `Playlist`, `Segment`, etc. from `@hls-downloader/shared`; import `GlobalOptions` from `@hls-downloader/core`.

### Compliance

Only use streams you are allowed to access, and follow the source site’s terms and applicable law.

### License

[MIT](LICENSE).

## Browser 大文件直写 / Large-file writable output

新增 `downloadToWritable(options, writable)`：Browser 按需读取分片并等待异步写入，输出 fMP4。Browser 与 Node 的 `writableOutput` 均为 true；回调流增量读取，但不等待异步消费。

`downloadToWritable(options, writable)` incrementally emits fMP4 with backpressure. Browser and Node support it. Callback streaming is incremental but does not await asynchronous consumers.

详见 [中文 API](docs/content/docs/zh/api/hls-downloader.mdx#downloadtowritable) / [English API](docs/content/docs/en/api/hls-downloader.mdx#downloadtowritable).

## Node resumable downloads / Node 可恢复下载（v3.6）

```ts
import { HlsDownloader } from '@logosw/hls-downloader/core';
import { NodeAdapter, type NodeAdapterResumeOptions } from '@logosw/hls-downloader/adapters/node';

const downloader = new HlsDownloader({ adapter: NodeAdapter });
const resume: NodeAdapterResumeOptions = { directory: './download-jobs/video' };
const result = await downloader.download({
  url: 'https://example.com/media.m3u8',
  filename: 'video',
  resume,
  signal: new AbortController().signal,
});
// After interruption, call download again with the same options and a new signal.
```

Use the same URL, headers, variant and output target after interruption. Node plain VOD downloads support verified segment caching and cross-process recovery; transcoding, aria2 and streaming output are excluded. Check `downloader.capabilities.resumableDownload`. Success removes media recovery data and keeps a small completion receipt and lock file. `clearCache()` does not delete the recovery directory.

中断后使用相同 URL、请求头、variant 和输出目标再次调用。仅支持 Node 普通 VOD 下载，不支持转码、aria2 和流式输出。失败保留恢复数据；成功清理媒体缓存，保留完成凭据和锁文件。`clearCache()` 不删除恢复目录。输入变化报 `RESUME_INVALID`，目录占用报 `RESUME_CONFLICT`，存储失败报 `RESUME_IO_FAILED`。

## Browser request context / 浏览器请求上下文

BrowserAdapter accepts instance `options.browserRequest` and per-call `browserRequest` on parsing, posters, downloading, streaming and writable output. Per-call values replace the whole instance configuration; `{}` selects native fetch defaults. The transport performs one attempt and returns a standard `Response`; the library owns retries and cancellation. WASM loading stays independent. Playlist and poster results are not cached between calls; `clearCache()` is a no-op for BrowserAdapter. Poster network failures expose structured errors, while undecodable video still returns `undefined`.

BrowserAdapter 支持实例和单次 `browserRequest`，用于解析、封面、下载和两种流式输出；单次配置整体替换实例配置，`{}` 使用原生默认值。传输函数返回标准 `Response`，只负责一次传输，库管理重试和取消；WASM 独立加载。播放列表和封面不跨调用缓存，`clearCache()` 保留为 no-op。封面网络错误抛出结构化错误，无可解码视频仍返回 `undefined`。

```ts
import { HlsDownloader } from '@logosw/hls-downloader/core';
import { BrowserAdapter } from '@logosw/hls-downloader/adapters/browser';

const mediaOrigin = 'https://media.example.com';
const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  options: {
    browserRequest: {
      credentials: 'include',
      async fetch(url, init) {
        const trusted = new URL(url).origin === mediaOrigin;
        const headers = new Headers(init.headers);
        if (trusted) headers.set('Authorization', 'Bearer <token>');
        init.signal?.throwIfAborted();
        return fetch(url, {
          ...init,
          headers,
          credentials: trusted ? init.credentials : 'omit',
          redirect: 'error',
        });
      },
    },
  },
});

await downloader.parseHls({ url: mediaOrigin + '/video.m3u8' });
await downloader.parseHls({ url: mediaOrigin + '/public.m3u8', browserRequest: {} });
```

Extensions own permissions, restricted-header rules and credential destination policies. Cookie/Referer/Origin cannot simply be replayed as ordinary headers; browser policies and site authorization may still prevent access. Do not attach site credentials unconditionally to CDN URLs or redirects. Explicit shared headers keep their existing behavior.

扩展负责权限、受限头规则及凭据目标域策略。Cookie/Referer/Origin 不能仅依赖普通 headers 重放；浏览器策略和站点授权仍可能阻止访问。不要无条件向 CDN 或重定向目标扩散凭据。详见中英文 Adapter API 文档。

## Audio selection and subtitles

Browser 与 Node 的 download、stream、writable 都支持通过 `audio: { language: 'en' }` 或 `{ groupId, name }` 选择一条音轨。省略时自动选默认轨道。`parseHls()` 返回 rendition 元数据，`downloadSubtitles()` 独立导出对齐的 WebVTT。新音轨能力不与恢复、转码或 aria2 组合。

Both adapters support one selected audio rendition across download, stream and writable output. Inspect `parseHls().renditions` on master results, and use `downloadSubtitles()` for an aligned WebVTT export. Audio selection cannot be combined with recovery, transcoding or aria2.

### AES-128 VOD

AES-128 有限 VOD 已支持 TS/fMP4、AVC/HEVC/AAC-LC 和单条外置音轨，可输出 MP4 文件/Blob 或 fMP4 stream/writable。默认按媒体请求策略读取 identity key；可通过每次调用的 `decryption.keyResolver` 替换。暂不支持加密恢复、转码、aria2 或加密字幕；Live/EVENT 请使用下文的 `startRecording()`。完整选项和预算见[适配器 API](docs/content/docs/zh/api/adapters.mdx#aes-128-vod)。

Finite AES-128 VOD supports TS/fMP4, AVC/HEVC/AAC-LC and one external audio track, with classic MP4 file/Blob and fMP4 stream/writable output. Identity keys use the media request policy by default; per-call `decryption.keyResolver` replaces it. Encrypted recovery, transcoding, aria2 and subtitles are unsupported; use `startRecording()` below for Live/EVENT. See the [adapter API](docs/content/docs/en/api/adapters.mdx#aes-128-vod) for options and resource budgets.

### 时间轴与 sample 解密 / Timeline and sample decryption

显式 `timeline` 支持有限范围、epoch 和 gap 策略，返回请求/实际可解码区间。`downloadOutputs()` 和 `downloadToWritables()` 提供多输出，`downloadSubtitleOutputs()` / `exportChapters()` 按报告生成 WebVTT sidecar。有限 TS SAMPLE-AES（AVC/AAC）及 fMP4 cbcs/cenc（AVC/HEVC/AAC）按清单自动启用。范围恢复、转码和 aria2 组合仍不支持；Live/EVENT 使用独立录制入口，详见[时间轴 API](docs/content/docs/zh/api/hls-downloader.mdx#时间范围与多输出)。

Opt-in `timeline` adds finite ranges, epochs, gap policies and requested/actual decodable intervals. `downloadOutputs()` / `downloadToWritables()` support multiple outputs; `downloadSubtitleOutputs()` / `exportChapters()` produce aligned WebVTT sidecars. Finite TS SAMPLE-AES (AVC/AAC) and fMP4 cbcs/cenc (AVC/HEVC/AAC) are selected automatically. Range recovery, transcoding and aria2 combinations remain unsupported; Live/EVENT uses the separate recording API. See the [timeline API](docs/content/docs/en/api/hls-downloader.mdx#timeline-ranges-and-multiple-outputs).

### 持续录制 / Continuous recording

`startRecording({ url, output })` 同步返回控制句柄：支持 Live/EVENT、VOD 暂停、停止排空和取消。Browser 可选择 writable 或必须指定 `maxBytes` 的 Blob；Node 可选择 writable 或不覆盖已有目标的文件。现有 `download*()` 保持有限下载语义。详见 [中文 API](docs/content/docs/zh/api/adapters.mdx)。

`startRecording({ url, output })` returns a control handle for Live/EVENT, pausable VOD, stop/drain and cancellation. Browser supports writable or explicitly bounded Blob output; Node supports writable or non-overwriting files. Existing `download*()` methods remain finite-only. See the recording section in the [Adapter API](docs/content/docs/en/api/adapters.mdx).
