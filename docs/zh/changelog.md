# 更新日志

本项目的所有重要变更均记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/)。

## [1.2.0] - 未发布

### 新增

- **RustAdapter**: 支持通过 `aria2` 选项配置启用 [aria2](https://aria2.github.io/) 下载分片。

### 变更

- **破坏性变更**：构造函数字段 `option` 重命名为 `options`，`setOption` 重命名为 `setOptions`，相关类型改为复数形式。

## [1.1.0] - 2026-04-13

### 新增

- **RustAdapter**: 使用独立分发的平台二进制包以减少包体积。
- **WasmAdapter**: 支持 `useESM` 配置以启用 esm 模块，解决 vite 下模块解析问题。

## [1.0.2] - 2026-04-08

### 新增

- **WasmAdapter**：运行时自动检测跨域隔离状态——当 `crossOriginIsolated` 或 `SharedArrayBuffer` 不可用时，适配器静默降级到单线程 `@ffmpeg/core` 构建，而非无限挂起。

- **Universal**: 增加视频封面缓存支持。

### 修复

- `WasmAdapter.init()` 不再因缺少 `SharedArrayBuffer` 支持导致多线程 FFmpeg 无法启动而挂起。
- `WasmAdapter.getPosterUrl()` 正确获取视频封面。

## [1.0.1] - 2026-03-26

首次公开发布。
