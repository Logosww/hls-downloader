# HLS 测试 Fixture 来源说明

本目录的 `.m3u8` fixture 来自以下上游开源项目，用于解析器单元测试。

## m3u8-rs `sample-playlists/`（MIT）

来源：<https://github.com/rutgersc/m3u8-rs/tree/master/sample-playlists>

与本仓库 Rust 解析器（`packages/adapters/src/node/crates/core/src/hls.rs` 中的
`m3u8_rs::parse_playlist_res`）同源，覆盖 master/media、`EXT-X-BYTERANGE`、
`EXT-X-DISCONTINUITY`、`EXT-X-MEDIA`（alt video）、`EXT-X-I-FRAME-STREAM-INF`、
多 codecs、cues、scte35 及若干边界（无尾换行、空行、零小数、无 segments）。

注意：`mediaplaylist.m3u8` 同时覆盖 **AES-128**（`EXT-X-KEY:METHOD=AES-128`）与
**LIVE**（无 `EXT-X-ENDLIST`），故未再单独补齐这两类 fixture。

License: MIT（见上游 LICENSE）。

## 手写补齐 fixture（RFC 8216 合规，本仓库编写）

以下文件按 RFC 8216 手写，用于补齐 m3u8-rs 样本未覆盖的场景（调研时 hls.js
fixture 在线定位不可靠，按计划 fallback 手写）：

- `fmp4-map.m3u8` — fMP4 媒体 playlist，含 `#EXT-X-MAP:URI=...`
- `sample-aes.m3u8` — `#EXT-X-KEY:METHOD=SAMPLE-AES,...`
- `master-subtitles.m3u8` — master，含 `#EXT-X-MEDIA:TYPE=SUBTITLES,...`

License: 随本仓库（MIT）。
