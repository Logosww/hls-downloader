# HLS Downloader

随时随地下载你喜爱的任何 HLS 视频流。Downloads HLS stream whatever and wherever you want. 

[![npm version](https://img.shields.io/npm/v/@logosw/hls-downloader?style=flat-square&logo=npm&label=npm)](https://www.npmjs.com/package/@logosw/hls-downloader)
[![npm downloads](https://img.shields.io/npm/dm/@logosw/hls-downloader?style=flat-square&logo=npm&label=downloads)](https://www.npmjs.com/package/@logosw/hls-downloader)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-Logosww%2Fhls--downloader-181717?style=flat-square&logo=github)](https://github.com/Logosww/hls-downloader)

---

用于解析 HLS（`.m3u8`）并下载、合并为可播放文件的 TypeScript 库。通过 `**HlsDownloader**` 统一入口，按运行环境选择适配器：

- **浏览器**：`@hls-downloader/adapters/browser`（FFmpeg WASM）
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

`@logosw/hls-downloader` 依赖 `@hls-downloader/core`、`@hls-downloader/shared`、`@hls-downloader/adapters`；`@hls-downloader/core` 已依赖 `@hls-downloader/shared`。使用适配器时（聚合包或独立安装）均需能解析到 `@hls-downloader/adapters` 中的 browser/node 实现（`/wasm`、`/rust` 为兼容别名）。

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
      event === HlsDownloaderEvent.STICHING_SEGMENTS
    ) {
      console.log(progress?.completed, '/', progress?.total);
    }
  },
});

// 下载前可显式 init；2.0 起普通下载不会在 init 阶段加载 FFmpeg
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

### `HlsDownloader` API 摘要


| 成员                                                                        | 说明                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `constructor({ adapter, options?, onEvent? })`                             | `options` 为 `GlobalOptions<T>`：`download`、`transcode` 及适配器专有字段，会与每次调用合并 |
| `init()`                                                                  | 初始化适配器状态；普通下载不会加载 FFmpeg，转码或封面提取会按需加载 FFmpeg                                                 |
| `isInit`                                                                  | 是否已完成初始化                                                                            |
| `globalOptions`                                                           | 当前默认选项，未设置时为 `null`                                                              |
| `setOptions(options)`                                                     | 更新默认选项                                                                               |
| `parseHls({ url, headers? })`                                             | 返回 `ParseHlsResult`：主列表 `playlist`、媒体列表 `segment` 或 `error`                         |
| `download({ url, headers?, filename?, maxRetry?, downloadConcurrency?, transcode?, ... })` | 下载并合并；`filename` 不含扩展名，扩展名由内部按容器生成。默认走 transmux/remux，显式 `transcode` 时进入 FFmpeg 路径。**BrowserAdapter** → `{ blobURL, totalSegments }`，**NodeAdapter** → `{ filePath, totalSegments }` |
| `getPosterUrl({ url, headers? })`                                         | 返回封面 URL 字符串，若无则 `undefined`                                                        |

`GlobalOptions.download` 字段：`headers`、`concurrency`、`maxRetry`。单次 `download({ downloadConcurrency })` 覆盖 `download.concurrency`。


### 事件 `HlsDownloaderEvent`

包括但不限于：`FFMPEG_LOADING` / `FFMPEG_LOADED`、`STARTING_DOWNLOAD`、`SOURCE_PARSED`、`DOWNLOADING`、`DOWNLOADING_SEGMENTS`、`STICHING_SEGMENTS`（后两者回调中带 `{ total, completed }`）、`READY_FOR_DOWNLOAD`、`ERROR`。在 `onEvent` 中按需监听即可。

### BrowserAdapter 专有选项

| 字段 | 类型 |
|------|------|
| `ffmpeg` | `object` |

`ffmpeg` 字段：`coreURL`、`wasmURL`、`workerURL`、`useESM`、`disableMultiThread`。

### NodeAdapter 专有选项

| 字段 | 类型 |
|------|------|
| `aria2` | `object` |

`aria2` 字段见文档 [Adapter API](docs/api/adapters.md)。

### 2.0 命名兼容

`BrowserAdapter` / `NodeAdapter` 是推荐名称。旧的 `WasmAdapter` / `RustAdapter` 仍可导入，但已标记为 deprecated，后续版本可能移除。

### 类型与扩展

高级用法可从 `@hls-downloader/shared` 引用 `ParseHlsResult`、`HlsDownloaderFetchOptions`、`HlsDownloaderDownloadOptions`、`HlsDownloaderGlobalDownloadOptions`、`Playlist`、`Segment` 等；从 `@hls-downloader/core` 引用 `GlobalOptions`。

### 合规

请仅处理您有权访问的流地址，并遵守来源站点条款与适用法律。

### 许可证

[MIT](LICENSE)。

---

A TypeScript library for parsing HLS (`.m3u8`) playlists and downloading/merging streams into playable files. Use the `**HlsDownloader**` facade and pick an adapter for your runtime:

- **Browser**: `@hls-downloader/adapters/browser` (FFmpeg WASM)
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

The `@logosw/hls-downloader` package depends on `@hls-downloader/core`, `@hls-downloader/shared`, and `@hls-downloader/adapters`. `@hls-downloader/core` depends on `@hls-downloader/shared`. For adapters, the browser/node implementations must resolve (via the umbrella or explicit `@hls-downloader/adapters`; `/wasm` and `/rust` are deprecated aliases).

**Runtime**: Node.js **≥ 20** (matches `engines` on `core` and the root package). The Node adapter loads a **native `.node` addon** on Node—use a build that matches your platform and Node ABI. For browser bundles, only include the **browser** subpath; do not bundle the Node native addon into frontend code.

### Packages and subpaths


| Package / entry                                   | Role                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@logosw/hls-downloader`                       | Umbrella: default export `HlsDownloader`, re-exports `shared`, WASM/Rust adapters (same as installing scoped packages) |
| `@logosw/hls-downloader/core`                  | Same as `@hls-downloader/core`                                                                                         |
| `@logosw/hls-downloader/shared`                | Same as `@hls-downloader/shared`                                                                                       |
| `@logosw/hls-downloader/adapters`, `.../browser`, `.../node` | Same as `@hls-downloader/adapters` and subpaths (`.../wasm`, `.../rust` are deprecated aliases) |
| `@hls-downloader/core`                            | `HlsDownloader` class                                                                                                  |
| `@hls-downloader/shared`                          | Types, `HlsDownloaderEvent`, `createAdapter`, etc. (pulled in via core/adapters)                                       |
| `@hls-downloader/adapters/browser`                   | Browser adapter `BrowserAdapter`                                                                                          |
| `@hls-downloader/adapters/node`                   | Node adapter `NodeAdapter`                                                                                             |


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
      event === HlsDownloaderEvent.STICHING_SEGMENTS
    ) {
      console.log(progress?.completed, '/', progress?.total);
    }
  },
});

// You may call init before download; ordinary downloads do not load FFmpeg in init
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

### `HlsDownloader` API overview


| Member                                                                    | Description                                                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `constructor({ adapter, options?, onEvent? })`                             | `options` is `GlobalOptions<T>`: `download`, `transcode`, and adapter-specific fields; merged into each call |
| `init()`                                                                  | Initialize lightweight adapter state; FFmpeg loads on demand for transcode / poster extraction               |
| `isInit`                                                                  | Whether initialization finished                                                                                   |
| `globalOptions`                                                           | Current default options, or `null` if unset                                                                       |
| `setOptions(options)`                                                     | Replace default options                                                                                           |
| `parseHls({ url, headers? })`                                             | Returns `ParseHlsResult`: `playlist`, `segment`, or `error`                                                       |
| `download({ url, headers?, filename?, maxRetry?, downloadConcurrency?, transcode?, ... })` | Download and merge; `filename` excludes the extension, which is generated internally from the container. Default transmux/remux, explicit `transcode` uses FFmpeg. **BrowserAdapter** → `{ blobURL, totalSegments }`, **NodeAdapter** → `{ filePath, totalSegments }` |
| `getPosterUrl({ url, headers? })`                                         | Poster URL string, or `undefined`                                                                                 |

`GlobalOptions.download` fields: `headers`, `concurrency`, `maxRetry`. Per-call `download({ downloadConcurrency })` overrides `download.concurrency`.


### `HlsDownloaderEvent` values

Includes (not limited to): `FFMPEG_LOADING` / `FFMPEG_LOADED`, `STARTING_DOWNLOAD`, `SOURCE_PARSED`, `DOWNLOADING`, `DOWNLOADING_SEGMENTS`, `STICHING_SEGMENTS` (the last two pass `{ total, completed }`), `READY_FOR_DOWNLOAD`, `ERROR`. Handle them in `onEvent` as needed.

### BrowserAdapter options

| Field | Type |
|-------|------|
| `ffmpeg` | `object` |

`ffmpeg` fields: `coreURL`, `wasmURL`, `workerURL`, `useESM`, `disableMultiThread`.

### NodeAdapter options

| Field | Type |
|-------|------|
| `aria2` | `object` |

See [Adapter API](docs/api/adapters.md) for `aria2` fields.

### 2.0 naming compatibility

`BrowserAdapter` / `NodeAdapter` are the recommended names. The old `WasmAdapter` / `RustAdapter` exports still work, but are deprecated and may be removed in a future major version.

### Types and extensions

Import `ParseHlsResult`, `HlsDownloaderFetchOptions`, `HlsDownloaderDownloadOptions`, `HlsDownloaderGlobalDownloadOptions`, `Playlist`, `Segment`, etc. from `@hls-downloader/shared`; import `GlobalOptions` from `@hls-downloader/core`.

### Compliance

Only use streams you are allowed to access, and follow the source site’s terms and applicable law.

### License

[MIT](LICENSE).