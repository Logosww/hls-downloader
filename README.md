# HLS Downloader

[npm version](https://www.npmjs.com/package/hls-downloader)
[License: MIT](https://opensource.org/licenses/MIT)
[Node.js](https://nodejs.org/)
[npm downloads](https://www.npmjs.com/package/hls-downloader)

---

用于解析 HLS（`.m3u8`）并下载、合并为可播放文件的 TypeScript 库。通过 `**HlsDownloader**` 统一入口，按运行环境选择适配器：

- **浏览器**：`@hls-downloader/adapters/wasm`（FFmpeg WASM）
- **Node.js**：`@hls-downloader/adapters/rust`（Rust N-API 原生实现，性能与路径处理更适合服务端）

### 安装

**方式一：聚合包 `hls-downloader`（推荐）** — 一次安装即可使用与 `@hls-downloader/`* 相同的 API，子路径与独立子包一一对应：

```bash
pnpm add hls-downloader
```

**方式二：按需安装子包**（减小依赖面或只引用部分能力时）：

```bash
pnpm add @hls-downloader/core @hls-downloader/shared
# 按需二选一（通常与运行环境一致）
pnpm add @hls-downloader/adapters   # 再通过子路径导入 wasm 或 rust，见下文
```

`hls-downloader` 依赖 `@hls-downloader/core`、`@hls-downloader/shared`、`@hls-downloader/adapters`；`@hls-downloader/core` 已依赖 `@hls-downloader/shared`。使用适配器时（聚合包或独立安装）均需能解析到 `**@hls-downloader/adapters**` 中的 wasm/rust 实现。

**运行环境**：Node.js **≥ 20**（与 `core` 及聚合包根 `engines` 一致）。Rust 适配器在 Node 下会加载 **原生 `.node` 模块**，需使用与你平台、Node ABI 匹配的发布产物；若在浏览器打包，请只打包 **WASM** 子路径，不要把 Node 原生模块打进前端。

### 基本用法

```ts
// 也可：import { HlsDownloader, HlsDownloaderEvent, WasmAdapter } from 'hls-downloader';
import { HlsDownloader } from '@hls-downloader/core';
import { HlsDownloaderEvent } from '@hls-downloader/shared';
import { WasmAdapter } from '@hls-downloader/adapters/wasm';

const downloader = new HlsDownloader({
  adapter: WasmAdapter,
  option: {
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

// 下载前必须先 init（WASM 会在此加载 FFmpeg）
await downloader.init();

// 仅解析主/子 playlist，不下载分片
const parsed = await downloader.parseHls({
  url: 'https://example.com/master.m3u8',
  headers: { Authorization: 'Bearer ...' },
});

// 解析并下载合并（filename 等见类型 HlsDownloaderDownloadOption）
const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  headers: {},
  filename: 'output.mp4',
});

if (result) {
  // result.blobURL：浏览器侧多为 blob: URL，可用于 <a download> 或创建 Object URL
  console.log(result.totalSegments);
}

// 尝试从流中取封面图 URL（若有）
const poster = await downloader.getPosterUrl({ url: '...' });
```

Node 侧将 `WasmAdapter` 换成 `RustAdapter` 即可，构造方式相同：

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust';

const downloader = new HlsDownloader({ adapter: RustAdapter, onEvent: ... });
await downloader.init();
```

### `HlsDownloader` API 摘要


| 成员                                                                        | 说明                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `constructor({ adapter, option?, onEvent? })`                             | `option` 为「默认请求选项 + 当前适配器专有选项」，会与每次 `parseHls` / `download` 传入的 `url`/`headers` 等合并 |
| `init()`                                                                  | 初始化适配器（WASM 会加载 FFmpeg；未完成前勿并发多次下载）                                                 |
| `isInit`                                                                  | 是否已完成初始化                                                                            |
| `setOption(option)`                                                       | 更新默认选项（不含单次请求的 `url`）                                                               |
| `parseHls({ url, headers? })`                                             | 返回 `ParseHlsResult`：主列表 `playlist`、媒体列表 `segment` 或 `error`                         |
| `download({ url, headers?, filename?, maxRetry?, downloadConcurrency? })` | 下载并合并；成功时返回 `{ blobURL, totalSegments }`（具体语义以适配器实现为准）                              |
| `getPosterUrl({ url, headers? })`                                         | 返回封面 URL 字符串，若无则 `undefined`                                                        |


### 事件 `HlsDownloaderEvent`

包括但不限于：`FFMPEG_LOADING` / `FFMPEG_LOADED`、`STARTING_DOWNLOAD`、`SOURCE_PARSED`、`DOWNLOADING`、`DOWNLOADING_SEGMENTS`、`STICHING_SEGMENTS`（后两者回调中带 `{ total, completed }`）、`READY_FOR_DOWNLOAD`、`ERROR`。在 `onEvent` 中按需监听即可。

### WASM 适配器专有选项（`init` / 构造时的 `option`）

在类型 `HlsDownloaderWasmAdapter` 上，常见项包括：

- `coreURL` / `wasmURL` / `workerURL`：自定义 FFmpeg 核心资源地址（默认构建时指向 CDN 上的 UMD 资源）
- `disableMultiThread`：为 `true` 时使用单线程 FFmpeg 变体（不加载 worker）

### 类型与扩展

高级用法可从 `@hls-downloader/shared` 引用 `ParseHlsResult`、`HlsDownloaderFetchOption`、`HlsDownloaderDownloadOption`、`Playlist`、`Segment` 等。若需自定义适配器，需实现 `HlsDownloaderAdapterInternal` 并通过 `createAdapter` 包装后交给 `HlsDownloader`（与内置适配器相同模式）。

### 合规

请仅处理您有权访问的流地址，并遵守来源站点条款与适用法律。

### 发布到 npm

子包 `packages/core`、`packages/shared`、`packages/adapters` 可各自独立发布（`@hls-downloader/*`）；仓库根目录的 `**hls-downloader**` 为聚合包，依赖上述已发布版本。发布前请在仓库根目录执行完整构建并登录 npm：

```bash
pnpm run build
# 仅发布三个子包（按依赖顺序由 pnpm 处理）
pnpm run publish:packages
# 子包已发布后，再发布聚合包（将 workspace 依赖替换为具体版本）
pnpm run publish:root
```

或一条命令（先子包、后根包）：`pnpm run publish:all`。应用目录 `packages/app/*` 为 `private`，不会被发布脚本选中。

### 许可证

[MIT](LICENSE)。

---

A TypeScript library for parsing HLS (`.m3u8`) playlists and downloading/merging streams into playable files. Use the `**HlsDownloader**` facade and pick an adapter for your runtime:

- **Browser**: `@hls-downloader/adapters/wasm` (FFmpeg WASM)
- **Node.js**: `@hls-downloader/adapters/rust` (Rust N-API; better fit for servers and path handling)

### Installation

**Option A — umbrella package `hls-downloader` (recommended):** one install exposes the same APIs as the scoped packages, with subpaths mirroring `@hls-downloader/`*:

```bash
pnpm add hls-downloader
```

**Option B — granular packages** (smaller install surface):

```bash
pnpm add @hls-downloader/core @hls-downloader/shared
pnpm add @hls-downloader/adapters
```

The `hls-downloader` package depends on `@hls-downloader/core`, `@hls-downloader/shared`, and `@hls-downloader/adapters`. `@hls-downloader/core` depends on `@hls-downloader/shared`. For adapters, the wasm/rust implementations must resolve (via the umbrella or explicit `@hls-downloader/adapters`).

**Runtime**: Node.js **≥ 20** (matches `engines` on `core` and the root package). The Rust adapter loads a **native `.node` addon** on Node—use a build that matches your platform and Node ABI. For browser bundles, only include the **WASM** subpath; do not bundle the Node native addon into frontend code.

### Packages and subpaths


| Package / entry                                   | Role                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `hls-downloader`                                  | Umbrella: default export `HlsDownloader`, re-exports `shared`, WASM/Rust adapters (same as installing scoped packages) |
| `hls-downloader/core`                             | Same as `@hls-downloader/core`                                                                                         |
| `hls-downloader/shared`                           | Same as `@hls-downloader/shared`                                                                                       |
| `hls-downloader/adapters`, `.../wasm`, `.../rust` | Same as `@hls-downloader/adapters` and subpaths                                                                        |
| `@hls-downloader/core`                            | `HlsDownloader` class                                                                                                  |
| `@hls-downloader/shared`                          | Types, `HlsDownloaderEvent`, `createAdapter`, etc. (pulled in via core/adapters)                                       |
| `@hls-downloader/adapters/wasm`                   | Browser adapter `WasmAdapter`                                                                                          |
| `@hls-downloader/adapters/rust`                   | Node adapter `RustAdapter`                                                                                             |


### Basic usage

```ts
// Or: import { HlsDownloader, HlsDownloaderEvent, WasmAdapter } from 'hls-downloader';
import { HlsDownloader } from '@hls-downloader/core';
import { HlsDownloaderEvent } from '@hls-downloader/shared';
import { WasmAdapter } from '@hls-downloader/adapters/wasm';

const downloader = new HlsDownloader({
  adapter: WasmAdapter,
  option: {
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

// Must call init before download (WASM loads FFmpeg here)
await downloader.init();

// Parse master/media playlist only; does not fetch segments
const parsed = await downloader.parseHls({
  url: 'https://example.com/master.m3u8',
  headers: { Authorization: 'Bearer ...' },
});

// Parse, fetch, and merge (filename etc.: see HlsDownloaderDownloadOption)
const result = await downloader.download({
  url: 'https://example.com/stream.m3u8',
  headers: {},
  filename: 'output.mp4',
});

if (result) {
  // result.blobURL: often a blob: URL in the browser; use with <a download> or Object URL
  console.log(result.totalSegments);
}

// Try to get a poster image URL from the stream, if present
const poster = await downloader.getPosterUrl({ url: '...' });
```

On Node, swap `WasmAdapter` for `RustAdapter`; construction is the same:

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust';

const downloader = new HlsDownloader({ adapter: RustAdapter, onEvent: ... });
await downloader.init();
```

### `HlsDownloader` API overview


| Member                                                                    | Description                                                                                                       |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `constructor({ adapter, option?, onEvent? })`                             | `option` holds default fetch options plus adapter-specific options; merged with each `parseHls` / `download` call |
| `init()`                                                                  | Initialize the adapter (WASM loads FFmpeg; avoid overlapping heavy downloads before init completes)               |
| `isInit`                                                                  | Whether initialization finished                                                                                   |
| `setOption(option)`                                                       | Update defaults (per-call `url` is not stored here)                                                               |
| `parseHls({ url, headers? })`                                             | Returns `ParseHlsResult`: `playlist`, `segment`, or `error`                                                       |
| `download({ url, headers?, filename?, maxRetry?, downloadConcurrency? })` | Download and merge; on success returns `{ blobURL, totalSegments }` (exact semantics depend on the adapter)       |
| `getPosterUrl({ url, headers? })`                                         | Poster URL string, or `undefined`                                                                                 |


### `HlsDownloaderEvent` values

Includes (not limited to): `FFMPEG_LOADING` / `FFMPEG_LOADED`, `STARTING_DOWNLOAD`, `SOURCE_PARSED`, `DOWNLOADING`, `DOWNLOADING_SEGMENTS`, `STICHING_SEGMENTS` (the last two pass `{ total, completed }`), `READY_FOR_DOWNLOAD`, `ERROR`. Handle them in `onEvent` as needed.

### WASM-only options (`init` / constructor `option`)

On `HlsDownloaderWasmAdapter`, common fields include:

- `coreURL` / `wasmURL` / `workerURL`: override FFmpeg asset URLs (default builds point at UMD assets on a CDN)
- `disableMultiThread`: if `true`, use the single-thread FFmpeg build (no worker)

### Types and extensions

Import `ParseHlsResult`, `HlsDownloaderFetchOption`, `HlsDownloaderDownloadOption`, `Playlist`, `Segment`, etc. from `@hls-downloader/shared`. For a custom adapter, implement `HlsDownloaderAdapterInternal`, wrap with `createAdapter`, and pass it to `HlsDownloader` (same pattern as built-ins).

### Compliance

Only use streams you are allowed to access, and follow the source site’s terms and applicable law.

### Publishing to npm

Workspace packages under `packages/core`, `packages/shared`, and `packages/adapters` publish as `@hls-downloader/*`. The repo root package `**hls-downloader**` is the umbrella and lists those as dependencies. Build from the repository root and log in to npm before publishing:

```bash
pnpm run build
pnpm run publish:packages
pnpm run publish:root
```

Or run `pnpm run publish:all` (subpackages first, then the umbrella). `packages/app/*` are `private` and are not published.

### License

[MIT](LICENSE).