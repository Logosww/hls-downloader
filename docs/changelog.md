# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [3.0.1] - 2026-07-09

### Fixed

- Fix unexpected PES packets missing in some cases during `NodeAdapter` transmux.

## [3.0.0] - 2026-07-05

### Added

- Entirely refactor `NodeAdapter` transmux implementation for better performance and stability, and brings more efficient concurrent segments downloading.
- `NodeAdpater` now introduces `downloadToStream` method to support live streaming while downloading HLS.

### Removed

- **Breaking**: Remove the deprecated `WasmAdapter` and `RustAdapter` aliases, the `HlsDownloaderWasmAdapter` / `HlsDownloaderRustAdapter` / `RustAdapterAria2Options` type aliases, the `@hls-downloader/adapters/wasm` and `@hls-downloader/adapters/rust` subpaths, and the `adapters-wasm` / `adapters-rust` umbrella entrypoints. Use `BrowserAdapter` / `NodeAdapter` (and the `browser` / `node` subpaths) everywhere.

## [2.0.0] - 2026-05-26

### Added

- Add `BrowserAdapter` and `NodeAdapter` as the recommended adapter names.
- Add explicit FFmpeg trigger options: `transcode`, `videoCodec`, `audioCodec`, `format`, preset profiles (`h264`, `hevc`, `vp9`), and structured encoding options (`crf`, `videoBitrate`, `audioBitrate`, `speed`).

### Changed

- **Breaking**: Ordinary HLS downloads now use the pure transmux/remux path by default and keep source codecs; pass `transcode` to opt in to FFmpeg-based encoding.
- **Breaking**: Download output naming now treats `filename` as the basename only. The final extension is resolved internally from the output container (`mp4` by default, preset/format-aware for transcode).
- **Breaking**: Adapter `init()` is now lightweight; FFmpeg is loaded only when transcoding, poster extraction, or an FFmpeg-backed path is used.
- **Deprecated**: `WasmAdapter` and `RustAdapter` remain available as compatibility aliases, but new code should use `BrowserAdapter` and `NodeAdapter`.

## [1.2.0] - 2026-05-02

### Added

- **NodeAdapter**: Introduce `aria2` option to support downloading segments via [aria2](https://aria2.github.io/).

### Changed

- **Breaking**: Rename constructor field `option` to `options`, `setOption` to `setOptions`, and pluralize option types.
- **Breaking** Rust adapter `download` method download and merge segments on disk and returns aboslute file path.

## [1.1.0] - 2026-04-13

### Added

- **NodeAdapter**: Use seperated optional native packages tu reduce package bundle size.
- **BrowserAdapter**: Support `useESM` option to load ffmpeg.wasm for vite user.

## [1.0.2] - 2026-04-08

### Added

- **BrowserAdapter**: Auto-detect cross-origin isolation at runtime — when `crossOriginIsolated` or `SharedArrayBuffer` is unavailable, the adapter silently falls back to the single-threaded `@ffmpeg/core` build instead of hanging indefinitely.
- **Universal**: Cache hls poster。

### Fixed

- `BrowserAdapter.init()` no longer hangs when multi-threaded FFmpeg cannot start due to missing `SharedArrayBuffer` support.
- `BrowserAdapter.getPosterUrl()` works correctly.

## [1.0.1] - 2026-03-26

Initial public release.