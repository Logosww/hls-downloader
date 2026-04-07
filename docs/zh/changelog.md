# 更新日志

本项目的所有重要变更均记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/)。

## [1.0.2] - 未发布

### 新增

- **WasmAdapter**：运行时自动检测跨域隔离状态——当 `crossOriginIsolated` 或 `SharedArrayBuffer` 不可用时，适配器静默降级到单线程 `@ffmpeg/core` 构建，而非无限挂起。

### 修复

- `WasmAdapter.init()` 不再因缺少 `SharedArrayBuffer` 支持导致多线程 FFmpeg 无法启动而挂起。
- `WasmAdapter.getPosterUrl()` 正确获取视频封面。

## [1.0.1] - 2025-03-23

首次公开发布。
