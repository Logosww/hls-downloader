# 更新日志

本项目的所有重要变更均记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/)。

## [3.0.1] - 2026-07-09

### Fixed

- 修复 `NodeAdapter` 在某些场景下 transmux 会丢失部分 PES packets 导致解码异常问题。

## [3.0.0] - 2026-07-05

### Added

- 彻底重构 `NodeAdapter` transmux 实现以获得更好的性能与稳定性，同时带来效率更高的并发下载分片能力。
- `NodeAdpater` 现在新增 `downloadToStream` 方法以实现 HLS 边下载边推流。

### 移除

- **破坏性变更**：彻底移除已弃用的 `WasmAdapter` 与 `RustAdapter` 别名、`HlsDownloaderWasmAdapter` / `HlsDownloaderRustAdapter` / `RustAdapterAria2Options` 类型别名、`@hls-downloader/adapters/wasm` 与 `@hls-downloader/adapters/rust` 子路径，以及聚合包 `adapters-wasm` / `adapters-rust` 入口。请统一使用 `BrowserAdapter` / `NodeAdapter`（及 `browser` / `node` 子路径）。

## [2.0.0] - 2026-05-26

### 新增

- 新增推荐适配器名称：`BrowserAdapter` 与 `NodeAdapter`。
- 新增显式 FFmpeg 触发选项：`transcode`、`videoCodec`、`audioCodec`、`format`、预设（`h264`、`hevc`、`vp9`）及结构化编码参数（`crf`、`videoBitrate`、`audioBitrate`、`speed`）。

### 变更

- **破坏性变更**：普通 HLS 下载默认走纯 transmux/remux 路径并保留源编码；需要 FFmpeg 编码时通过 `transcode` 显式启用。
- **破坏性变更**：下载输出命名现在将 `filename` 视为 basename，不再要求传入扩展名；最终扩展名由内部根据输出容器解析（默认 `mp4`，设置 transcode 时感知 preset/format）。
- **破坏性变更**：适配器 `init()` 变为轻量初始化；只有转码、封面提取或 FFmpeg-backed 路径才会加载 FFmpeg。
- **已弃用**：`WasmAdapter` 与 `RustAdapter` 仍作为兼容别名保留；新代码请使用 `BrowserAdapter` 与 `NodeAdapter`。

## [1.2.0] - 2026-05-02

### 新增

- **NodeAdapter**: 支持通过 `aria2` 选项配置启用 [aria2](https://aria2.github.io/) 下载分片。

### 变更

- **破坏性变更**：构造函数字段 `option` 重命名为 `options`，`setOption` 重命名为 `setOptions`，相关类型改为复数形式。
- **破坏性变更** Rust 适配器 `download` 方法下载合并分片落盘而非存于内存中，并返回文件绝对路径。

## [1.1.0] - 2026-04-13

### 新增

- **NodeAdapter**: 使用独立分发的平台二进制包以减少包体积。
- **BrowserAdapter**: 支持 `useESM` 配置以启用 esm 模块，解决 vite 下模块解析问题。

## [1.0.2] - 2026-04-08

### 新增

- **BrowserAdapter**：运行时自动检测跨域隔离状态——当 `crossOriginIsolated` 或 `SharedArrayBuffer` 不可用时，适配器静默降级到单线程 `@ffmpeg/core` 构建，而非无限挂起。

- **Universal**: 增加视频封面缓存支持。

### 修复

- `BrowserAdapter.init()` 不再因缺少 `SharedArrayBuffer` 支持导致多线程 FFmpeg 无法启动而挂起。
- `BrowserAdapter.getPosterUrl()` 正确获取视频封面。

## [1.0.1] - 2026-03-26

首次公开发布。
