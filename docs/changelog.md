# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - Unreleased

### Added

- **RustAdapter**: Use seperated optional native packages tu reduce package bundle size.
- **WasmAdapter**: Support `useESM` option to load ffmpeg.wasm for vite user.

## [1.0.2] - 2026-04-08

### Added

- **WasmAdapter**: Auto-detect cross-origin isolation at runtime — when `crossOriginIsolated` or `SharedArrayBuffer` is unavailable, the adapter silently falls back to the single-threaded `@ffmpeg/core` build instead of hanging indefinitely.
- **Universal**: Cache hls poster。

### Fixed

- `WasmAdapter.init()` no longer hangs when multi-threaded FFmpeg cannot start due to missing `SharedArrayBuffer` support.
- `WasmAdapter.getPosterUrl()` works correctly.

## [1.0.1] - 2026-03-26

Initial public release.
