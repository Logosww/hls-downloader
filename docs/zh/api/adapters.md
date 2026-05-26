# 适配器 API

适配器专有字段通过 `HlsDownloader` 构造函数 `options` / `setOptions` 传入，或在单次 `download()` 调用中传入。与单次选项合并时，单次选项优先。

::: info 默认 Transmux，FFmpeg 按需加载
各适配器的**普通下载默认走 transmux/remux，不加载 FFmpeg**。仅当具体 API 需要时才会初始化 FFmpeg。下文表格列出**各适配器何时加载 FFmpeg**。
:::

## BrowserAdapter

```ts
import { BrowserAdapter } from '@hls-downloader/adapters/browser'
```

普通下载走**浏览器轻量 transmux 路径**。**不会加载 `@ffmpeg/ffmpeg`**，除非满足下方 FFmpeg 场景。

### 何时加载 FFmpeg

| API | 加载 FFmpeg？ | 条件 |
|-----|-------------|------|
| `parseHls()` | 否 | — |
| `init()` | 否 | — |
| `download()` | **否**（默认） | 省略 `transcode` 与 `globalOptions.transcode` → 仅 transmux |
| `download()` | **是** | 带 `preset` 或显式输出编码的 `transcode`，或 `globalOptions.transcode` |
| `getPosterUrl()` | 否 | 仅基于分片的轻量提取 |

加载 FFmpeg 时，适配器会自动检测 `crossOriginIsolated` 和 `SharedArrayBuffer` 是否可用来判断多线程支持。若不可用，则自动降级到单线程 `@ffmpeg/core` 构建。

加载 FFmpeg 核心资源时，CDN 上 **ESM** 与 **UMD** 路径由 `ffmpeg.useESM` 决定（`true` → `esm/`，省略或 `false` → `umd/`）。

`WasmAdapter` 仍作为兼容别名保留，但已 deprecated。新代码请优先使用 `BrowserAdapter`。

### `download()` 返回值

| 字段 | 类型 |
|------|------|
| `blobURL` | `string` |
| `totalSegments` | `number` |

### 适配器专有选项

| 字段 | 类型 |
|------|------|
| `ffmpeg` | `object` |

#### `ffmpeg` 对象

| 字段 | 类型 |
|------|------|
| `coreURL` | `string` |
| `wasmURL` | `string` |
| `workerURL` | `string` |
| `useESM` | `boolean` |
| `disableMultiThread` | `boolean` |

## NodeAdapter

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node'
```

普通下载走**原生 transmux 路径**。**不会初始化原生 FFmpeg**，除非满足下方 FFmpeg 场景。

`RustAdapter` 仍作为兼容别名保留，但已 deprecated。新代码请优先使用 `NodeAdapter`。

### 何时加载 FFmpeg

| API | 加载 FFmpeg？ | 条件 |
|-----|-------------|------|
| `parseHls()` | 否 | — |
| `init()` | 否 | — |
| `download()` | **否**（默认） | 省略 `transcode` / `globalOptions.transcode` 且未启用 `aria2.enabled` → 仅 transmux |
| `download()` | **是** | 设置 `transcode` 选项对象、`globalOptions.transcode`，**或** `aria2.enabled: true` |
| `getPosterUrl()` | **视情况** | 仅当轻量分片提取失败、需要 FFmpeg 回退时 |

### `download()` 返回值

| 字段 | 类型 |
|------|------|
| `filePath` | `string` |
| `totalSegments` | `number` |

### 适配器专有选项

| 字段 | 类型 |
|------|------|
| `aria2` | `object` |

分片下载默认使用内置 HTTP；将 `aria2.enabled` 设为 `true` 后改用 [aria2](https://aria2.github.io/)（`aria2c` CLI + 会话输入文件）。

`aria2.enabled` 为 `true` 时需安装 aria2。自定义请求头会写入 aria2 会话文件（每条 URI 下 `header=Name: value`）。

#### `aria2` 对象（`NodeAdapterAria2Options`）

| 字段 | 类型 |
|------|------|
| `enabled` | `boolean` |
| `path` | `string` |
| `maxConcurrentDownloads` | `number` |
| `maxConnectionPerServer` | `number` |
| `split` | `number` |
| `minSplitSize` | `string` |
| `extraArgs` | `string[]` |

未传 `maxConcurrentDownloads` 时，实际并发数跟随每次 `download()` 的 `downloadConcurrency`（或 `globalOptions.download.concurrency`）。

### 平台支持

原生模块必须匹配你的操作系统和 Node.js ABI。常见平台已发布预构建二进制文件。
