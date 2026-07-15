# 适配器 API

适配器专有字段通过 `HlsDownloader` 构造函数 `options` / `setOptions` 传入，或在单次 `download()` 调用中传入。与单次选项合并时，单次选项优先。

::: info 默认 Transmux
各适配器的**普通下载默认走 transmux/remux，不重编码**。BrowserAdapter 使用 [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly 做 transmux，使用 Mediabunny WebCodecs 做 `transcode`；NodeAdapter 仅在需要时初始化原生 FFmpeg。
:::

## BrowserAdapter

```ts
import { BrowserAdapter } from '@hls-downloader/adapters/browser'
```

普通下载使用 [hls-transmux](https://github.com/Logosww/hls-transmux) WebAssembly。`download()` 返回经典 fast-start MP4；`downloadToStream()` 输出 fragmented MP4 分块。

转码使用 Mediabunny 与 WebCodecs，不依赖 `@ffmpeg/ffmpeg`。BrowserAdapter 支持 `h264`、`hevc`、`vp9` 预设及可选的 `videoBitrate`、`audioBitrate`。当前浏览器不支持所需编码器配置时会明确报错。

参考 CPU 微基准（8 分片 fixture，Chrome 150 / macOS，3 次中位数）：transmux 相对 Mediabunny remux 约 **5.0×**；H.264 转码相对多线程 `ffmpeg.wasm` 约 **2.2×**。详见[适配器指南](/zh/guide/adapters#性能参考)。

### `download()` 返回值

| 字段 | 类型 |
|------|------|
| `blobURL` | `string` |
| `totalSegments` | `number` |

## NodeAdapter

```ts
import { NodeAdapter } from '@hls-downloader/adapters/node'
```

普通下载走**原生 transmux 路径**。**不会初始化原生 FFmpeg**，除非满足下方 FFmpeg 场景。

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
