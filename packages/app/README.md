# Web / Bun 应用

两个应用已适配 SDK 3.9.0 的有限 VOD 时间轴与 sample 解密。默认完整下载保留原流程；时间轴功能须显式启用。

## Web

解析链接后，在确认窗口选择「时间轴下载」：

- 起止时间填写非负秒数，最多 9 位小数，范围为 `[start,end)`；同时留空表示整个媒体。实际范围会扩展到可解码边界，结果列表展示请求和实际范围，并可保存完整 JSON 报告。
- 缺口默认保留，可选择压缩；配置变化默认失败，可选择拆分独立文件。普通下载产生 classic MP4 Blob，每个输出单独保存。大文件直存输出 fMP4，拆分时先选择文件夹，再按 `basename.001.mp4`、`basename.002.mp4` 写入。
- 高级 JSON 只接受 `epochAnchors`、`limits`、`tailDuration`，直接遵循 SDK 契约。例如 `{"limits":{"samples":500000,"resources":2000}}`。时间使用 `{"ticks":"90000","timescale":90000}`；锚点指定 `inputId`、`epoch`、`source`、`presentation`。
- 可选择当前质量对应的 WebVTT 字幕组；章节每行填写 `0.2 --> 30 | 标题`。完成媒体后依据同一报告导出各输出的 WebVTT，独立保存。字幕同步证据不足或导出失败时，媒体仍可保存。
- 第二输出失败或取消后，已关闭的文件保留并继续显示；未完成的新建文件清理，已有目标文件由浏览器 writable 的 abort 保持原内容。移除任务释放应用持有的 Blob URL，不删除已保存文件。

浏览器须在安全上下文支持 File System Access API 才能直存；拆分直存另需目录选择器。扫描会增加首写延迟；规划预算不是内存上限，普通下载仍保留完整媒体于内存。时间轴下载不支持转码或当前「直接播放」路径：合流 fMP4 不能承诺直接追加到单个 MSE SourceBuffer。

## Bun HTTP API

`POST /download` 新增可选 `timeline`，接受 SDK 的范围、gap、锚点、预算、尾帧和 `changePolicy`。例如：

```json
{
  "url": "https://example.test/master.m3u8",
  "filename": "movie",
  "timeline": {
    "range": {
      "start": { "ticks": "200", "timescale": 1000 },
      "end": { "ticks": "4200", "timescale": 1000 }
    },
    "gapPolicy": "preserve",
    "changePolicy": "split"
  }
}
```

保留原 `variant`、`audio`、`headers` 和任务操作。时间轴与转码组合、`stream: true` 与 `changePolicy: "split"` 在创建任务前返回 422；单输出 stream 可使用时间轴且固定 fail。有限文件下载使用任务唯一 basename，完成后移动至 TaskManager 的 `outputDirectory`，响应不暴露磁盘路径。

| 接口                              | 行为                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /downloads/:id`              | 原任务字段，加 `timeline`、`timelineReport`、有序 `outputs: [{index,filename}]`、`errorCode`、取消时的 `settling`                 |
| `GET /downloads/:id/report`       | 取得成功完成的时间轴报告；未完成或无报告为 409，到期为 410                                                                        |
| `GET /downloads/:id/files/:index` | 下载指定已完成文件，index 是报告中的字符串；即使后续失败或取消仍可访问；不存在为 404，到期为 410                                  |
| `GET /downloads/:id/file`         | 原单文件入口；多个输出时为 409，提示选择输出                                                                                      |
| `POST /downloads/:id/subtitles`   | 使用任务保存的源 URL、选择和请求头，接收 `{subtitle:{groupId,name},track?,filename?}`，返回 `{operationId,totalSegments,outputs}` |
| `POST /downloads/:id/chapters`    | 接收 `{chapters:[{range,title,id?}],track?,filename?}`，返回 WebVTT sidecar 列表                                                  |

字幕和章节接口要求成功完成的同一任务报告，`track` 可指定 `{inputId,trackId}`；导出失败为 422，不改变媒体任务状态。旧 `POST /subtitles` 返回形状不变。SSE 的取消事件在 `settling: true` 时继续等待，在收尾完成后发送含已完成输出的最终事件。输出 TTL 从收尾完成开始，统一过期和清理。

## 解密与边界

两个应用通过清单自动使用 identity HTTP key provider，无需时间轴配置。继续传递已有请求头，支持 TS SAMPLE-AES（AVC/AAC-LC）及 fMP4 cbcs/cenc（AVC/HEVC/AAC-LC），以及一条关联外置音轨。非 identity 的自定义 key resolver 仍由 SDK 调用方接入，应用没有新增密钥输入控件。CBC/CTR 无认证，不能保证识别全部错误密钥。

本轮没有增加 Live/EVENT、恢复、转码与时间轴组合、字幕资源解密、字幕内嵌或多音轨。后续路线图状态保持不变。

## 验证

```sh
pnpm test:app-bun
pnpm test:unit
# 先启动 Web 开发服务器；默认测试地址为 http://localhost:3100
HLS_APP_WEB_URL=http://localhost:3100 pnpm test:app-web:timeline
```

Chrome 脚本使用 Playwright，可通过 `HLS_TEST_CHROMIUM_PATH` 指定实际 Chrome；媒体验收需 FFmpeg / FFprobe。新增测试覆盖范围、拆分、自动 sample 解密、字幕/章节、规划预算、第二输出失败、取消及迟到 Promise，复用真实 native/WASM 和独立加密 fixture。Web 原直存、关联音轨和 metadata 取消测试入口仍保留。
