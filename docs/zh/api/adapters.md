# 适配器 API

## WasmAdapter

```ts
import { WasmAdapter } from '@hls-downloader/adapters/wasm'
```

WASM 适配器底层使用 `@ffmpeg/ffmpeg`，在 WebAssembly 中编译并运行 FFmpeg，适用于浏览器环境。

初始化时，适配器会自动检测 `crossOriginIsolated` 和 `SharedArrayBuffer` 是否可用来判断多线程支持。若不可用，则自动降级到单线程 `@ffmpeg/core` 构建，避免 `init()` 挂起。

加载 FFmpeg 核心资源时，CDN 上 **ESM** 与 **UMD** 路径仅由 `useESM` 决定（`true` → `esm/`，省略或 `false` → `umd/`）。

### `download()` 返回值

成功时解析为 `{ blobURL: string, totalSegments: number }`。`blobURL` 为浏览器中合并后文件的 `blob:` 对象 URL。

### 额外选项

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `coreURL` | `string` | CDN 地址 | FFmpeg 核心 JavaScript URL |
| `wasmURL` | `string` | CDN 地址 | FFmpeg WASM 二进制 URL |
| `workerURL` | `string` | CDN 地址 | FFmpeg Worker URL |
| `useESM` | `boolean` | `false` | 使用 CDN 上的 ESM（`true`）或 UMD（`false` / 省略）资源 |
| `disableMultiThread` | `boolean` | `false` | 禁用多线程（不加载 Worker） |

## RustAdapter

```ts
import { RustAdapter } from '@hls-downloader/adapters/rust'
```

Rust 适配器加载原生 `.node` N-API 模块。提供原生性能的 HLS 解析、分片下载和流合并。

### `download()` 返回值

成功时解析为 `{ filePath: string, totalSegments: number }`。`filePath` 为合并后文件在**本机磁盘上的绝对路径**。

### 额外选项

通过 `HlsDownloader` 的 `options` / `setOptions` 传入（会合并进每次 `download()`）。分片下载默认使用 **reqwest**；将 `aria2.enabled` 设为 `true` 后改用 **aria2**（`aria2c` CLI + 会话输入文件）。

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `aria2` | `object` | — | 可选。启用并配置 aria2 下载分片（字段见下表）。省略则使用内置 HTTP。 |

`aria2.enabled` 为 `true` 时需安装 [aria2](https://aria2.github.io/)。自定义请求头会写入 aria2 会话文件（每条 URI 下 `header=Name: value`）。若 aria2 不可用或执行失败，`download()` 会抛出明确错误。

分片并发数由各次 **`downloadConcurrency`**（未传则用适配器 **`chunkDownloadConcurrency`** 默认值）控制；失败重试次数由 **`maxRetry`** 对应 aria2 的 `--max-tries`。

### `aria2` 对象（`RustAdapterAria2Options`）

对外 TypeScript 类型与原生绑定 **`NapiAria2Config`** 一致。

| 字段 | 类型 | 描述 |
|------|------|------|
| `enabled` | `boolean` | 可选。为 `true` 时用 aria2 下载分片；省略视为 `false`。 |
| `path` | `string` | 可选。`aria2c` 可执行文件路径（未在 `PATH` 上且 `enabled` 为 `true` 时使用）。 |
| `maxConcurrentDownloads` | `number` | 可选。对应 `--max-concurrent-downloads`；不传则使用本次 `download` 的 `downloadConcurrency` |
| `maxConnectionPerServer` | `number` | 可选。对应 `--max-connection-per-server` |
| `split` | `number` | 可选。对应 `--split` |
| `minSplitSize` | `string` | 可选。对应 `--min-split-size`（例如 `'1M'`） |
| `extraArgs` | `string[]` | 可选。在内置参数之后追加的额外命令行参数（高级用法） |

### 平台支持

原生模块必须匹配你的操作系统和 Node.js ABI。常见平台已发布预构建二进制文件。
