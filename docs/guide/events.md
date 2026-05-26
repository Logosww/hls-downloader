# Events

HLS Downloader provides a rich event system through `HlsDownloaderEvent` for tracking download progress and handling errors in real time.

## Listening to Events

Pass an `onEvent` callback in the `HlsDownloader` constructor:

```ts
import { HlsDownloader } from '@hls-downloader/core'
import { HlsDownloaderEvent } from '@hls-downloader/shared'
import { BrowserAdapter } from '@hls-downloader/adapters/browser'

const downloader = new HlsDownloader({
  adapter: BrowserAdapter,
  onEvent: (event, payload) => {
    switch (event) {
      case HlsDownloaderEvent.DOWNLOADING_SEGMENTS:
        console.log(`Downloading: ${payload?.completed}/${payload?.total}`)
        break
      case HlsDownloaderEvent.STICHING_SEGMENTS:
        console.log(`Stitching: ${payload?.completed}/${payload?.total}`)
        break
      case HlsDownloaderEvent.ERROR:
        console.error('Download error')
        break
    }
  },
})
```

## Event Reference

| Event | Payload | Description |
|-------|---------|-------------|
| `FFMPEG_LOADING` | — | FFmpeg core is being loaded (WASM only) |
| `FFMPEG_LOADED` | — | FFmpeg core has been loaded (WASM only) |
| `STARTING_DOWNLOAD` | — | Download process has started |
| `SOURCE_PARSED` | — | HLS source has been parsed |
| `DOWNLOADING` | — | Download is in progress |
| `DOWNLOADING_SEGMENTS` | `{ total, completed }` | Segment download progress |
| `STICHING_SEGMENTS` | `{ total, completed }` | Segment stitching/merging progress |
| `READY_FOR_DOWNLOAD` | — | Merged file is ready |
| `ERROR` | — | An error occurred |

## Progress Tracking

The `DOWNLOADING_SEGMENTS` and `STICHING_SEGMENTS` events provide a progress payload with `total` and `completed` fields:

```ts
type ProgressPayload = {
  total: number
  completed: number
}
```

These are the only two events that include a payload. All other events are emitted without additional data.
