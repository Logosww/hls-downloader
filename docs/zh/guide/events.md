# 事件

HLS Downloader 通过 `HlsDownloaderEvent` 提供丰富的事件系统，用于实时追踪下载进度和处理错误。

## 监听事件

在 `HlsDownloader` 构造函数中传入 `onEvent` 回调：

```ts
import { HlsDownloader } from '@hls-downloader/core'
import { HlsDownloaderEvent } from '@hls-downloader/shared'
import { BrowserAdapter } from '@hls-downloader/adapters/browser'

const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  onEvent: (event, payload) => {
    switch (event) {
      case HlsDownloaderEvent.DOWNLOADING_SEGMENTS:
        console.log(`下载中: ${payload?.completed}/${payload?.total}`)
        break
      case HlsDownloaderEvent.STITCHING_SEGMENTS:
        console.log(`合并中: ${payload?.completed}/${payload?.total}`)
        break
      case HlsDownloaderEvent.ERROR:
        console.error('下载出错')
        break
    }
  },
})
```

## 事件参考

| 事件 | 载荷 | 描述 |
|------|------|------|
| `FFMPEG_LOADING` | — | FFmpeg 核心正在加载（仅 WASM） |
| `FFMPEG_LOADED` | — | FFmpeg 核心已加载（仅 WASM） |
| `STARTING_DOWNLOAD` | — | 下载流程已开始 |
| `SOURCE_PARSED` | — | HLS 源已解析 |
| `DOWNLOADING` | — | 下载进行中 |
| `DOWNLOADING_SEGMENTS` | `{ total, completed }` | 分片下载进度 |
| `STITCHING_SEGMENTS` | `{ total, completed }` | 分片合并进度 |
| `READY_FOR_DOWNLOAD` | — | 合并文件已就绪 |
| `ERROR` | — | 发生错误 |

## 进度追踪

`DOWNLOADING_SEGMENTS` 和 `STITCHING_SEGMENTS` 事件提供包含 `total` 和 `completed` 字段的进度载荷：

```ts
type ProgressPayload = {
  total: number
  completed: number
}
```

这是仅有的两个包含载荷的事件。其他事件均不携带额外数据。
