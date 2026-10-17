# hls-engine 1.0.2 integration validation

Verified on macOS arm64, 2026-10-09; registry 1.0.2 and player follow-up on 2026-10-10. Native core, N-API and WASM use the
unmodified crates.io `hls-engine = "=1.0.2"` package. Both Cargo locks resolve
that registry release; no Git, local-path or source patch is applied. Library package
versions remain unchanged and no publication was performed.

## Closed: upstream #3, AAC decode gaps in classic MP4

The patch corresponding to upstream commit `860a907` fixes
[hls-engine #3](https://github.com/Logosww/hls-engine/issues/3). The existing
`negative-cts` fixture and its original decoded-frame equality assertions pass.
Classic MP4 and fMP4 both contain 60 decoded video frames and 62 decoded AAC
frames (122 combined), instead of the old classic result of 219 combined frames.
The independent registry-only Rust contract passes without library networking,
N-API, WASM or library timeline conversion. Historical media goldens were not changed.

```sh
CARGO_NET_OFFLINE=true cargo test --manifest-path packages/adapters/src/node/crates/core/Cargo.toml --test engine_upstream -- --nocapture
pnpm --filter @hls-downloader/test exec vitest run timeline.integration.test.ts
HLS_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm --filter @hls-downloader/test exec node browser/timeline-smoke.ts
```

Rust contracts: 3 passed. Library timeline: 65 passed. Real Chrome timeline: 21
WASM report/hash comparisons and three key-cancellation cases passed. Chrome
hashes compare fMP4 with Node-hosted WASM; Native classic/fMP4 parity is separately
checked by FFmpeg decoded samples because container layouts differ. The AAC fix
does not establish playback support for arbitrary empty edits or decode gaps in
other codecs. `queryCapability()` retains its player-specific restrictions.

## Library independent acceptance

The full Vitest run passed **704 tests**, with four environment-gated tests skipped.
A final focused recovery/transcode run passed 48 tests, including the additional
public cancellation-and-cleanup case. The separate local-package acceptance command passed 15 tests, and the Bun example
passed 26 tests. Native/WASM bindings and all library distribution entrypoints were
rebuilt. These overlapping suites must not be added into a unique-test total.

| Area | Executed evidence | Result / scope |
| --- | --- | --- |
| Recovery | `m4-recovery.integration.test.ts`, 27 profiles | Interrupted/resumed and uninterrupted decoded A/V equality; schema-2, stable key versions, terminal restore without network |
| Runtime/output matrix | `m4-output.integration.test.ts`, 81 cases | Same 27 profiles × finite/Live/EVENT, Native and WASM, callback/writable parity, slow writes and close completion |
| AES-128 | TS/fMP4 single/default or selected audio, range, encrypted MAP, original sequence IV, NONE, rotation | Covered in recovery/output profiles; existing keyed and timeline suites retain malformed-key/range and cancellation boundaries |
| Sample encryption | TS AVC/AAC SAMPLE-AES; fMP4 AVC/HEVC/AAC cenc/cbcs, dual schemes, per-sample/constant IV | Covered where fixture/container supports the codec; encrypted subtitle resources remain rejected |
| Packed AAC | Clear, AES-128, SAMPLE-AES, both rotation profiles | VOD/Live/EVENT and recovery; ten Native/WASM boundary cases validate missing/invalid ID3, 33-bit wrap, offsets and decoded frames |
| Experimental GCM | TS/fMP4/Packed AAC, single and selected audio | Six opt-in recovery/output profiles; existing real Chrome checks cover default rejection, key length, tag failure and capacity |
| Node transcode | `transcode-selected.integration.test.ts`, 21 cases | h264/hevc/vp9, encrypted single selected audio, ranges, default/explicit selection, sample encryption, destination conflicts and staging removal |
| Encoder cancellation | `transcode-process.integration.test.ts` | Non-cooperative FFmpeg receives SIGKILL after grace period; operation waits for process reaping |
| Existing fault/recording matrix | `node-resume`, `recording`, `engine`, `timeline`, `multitrack`, `writable-output` suites | SIGKILL recovery, version/prefix/output conflicts, window fail/skip/split, independent EOF, gap/discontinuity/split, plaintext subtitles, multiple audio, write/close failure and cancellation |
| Real Chrome recording/multitrack | `browser/recording-smoke.ts`, `browser/multitrack-smoke.ts` | 13 recording report/hash comparisons; multi-track report/hash parity, five Packed AAC profiles, blocked-writer cancellation |

Run `pnpm test:m4` for the new independent matrix. Run the full library suite with
`pnpm --filter @hls-downloader/test exec vitest run`. Run `pnpm test:publish` to
pack and inspect isolated tarballs locally; this command does not publish them.

The matrix is an explicit set of applicable profiles, not every Cartesian product.
Classic file and fMP4/blob differences, split, subtitles and extra audio tracks are
covered in the existing suites rather than inferred from one passing writable.
Recovery publication/partial files are intentionally retained by the engine for
crash replay; this differs from ephemeral transcode staging, removed on success,
error and cancellation.

## Real player and transcode evidence

`browser/transcode-smoke.ts` uses Google Chrome 155.0.8059.40 with actual WebCodecs,
then independently checks codecs/timestamps with ffprobe, decodes with FFmpeg and
plays every successful result to `ended` in a native HTML media element.

| Chrome case | Actual output | Decodable range | Playback |
| --- | --- | --- | --- |
| AES-128 selected audio, h264 | H.264/AAC MP4 | 4 s, audio starts 5.333 ms after video | 120 frames, ended |
| AES-128 selected audio, hevc | HEVC/AAC MP4 | 4 s, audio starts 5.333 ms after video | 120 frames, ended |
| AES-128 selected audio, vp9 | VP9/Opus WebM | 4 s, audio starts 5 ms after video | 120 frames, ended |
| Clear default audio, vp9 | VP9/Opus WebM | 4 s | 120 frames, ended |
| Selected sample-encrypted dual schemes | VP9/Opus WebM | 4 s, audio starts 3 ms after video | 120 frames, ended |
| HEVC cbcs video-only | VP9 WebM | 6 s | 178 frames, ended |

These ranges expand to the Engine's decodable boundaries; they are not exact
frame trimming. Browser output-capacity rejection, encoder cancellation and a fresh-page missing
VideoEncoder rejection also passed without unhandled page errors. Other environments may lack a requested
encoder: the operation must return `UNSUPPORTED_OUTPUT` / `UnsupportedEncoder`
instead of dropping a selected track or silently changing codecs.

The 2026-10-10 follow-up measures Safari/AVFoundation, IINA, VLC, Chrome and
Shaka directly. See [player acceptance](players/README.md) for versions, actual
positive/negative observations, reproducible probes and retained evidence.
Registry 1.0.2 passes 705 library tests (five environment-gated skips), three Rust
contracts and 21 real-Chrome WASM timeline/hash comparisons plus three key
cancellation cases. Native/WASM and library distributions were rebuilt. No media
baseline or original #3 assertion was relaxed.

## Contract freeze and remaining work

Delivered options retain their existing public shape. Remux/recording return the
Engine report; transcoding returns the final file/blob and segment count without
presenting an intermediate remux report as a report of the encoded output.
Node requires FFmpeg on PATH; Browser buffers bounded intermediate and encoded
media (each bounded by `maxBytes`, default 256 MiB). Presets operate on selected,
decrypted, timeline-processed fMP4. Transcode+recording/resume/split/stream,
multi-audio container transcoding and subtitle burning remain unsupported.
`queryCapability()` describes Engine combinations, not runtime encoder discovery.

Upstream 1.0.2 (commit `6a107c7`) has delivered AES-128 WebVTT resource reads,
subtitle commit/backpressure and recoverable sidecar contracts. All three library
Rust dependencies and both lockfiles now use the published registry version.
The library now bridges encrypted subtitle resources and acknowledged continuous
sidecars on Native and WASM, including Node fixed paths and schema-2 recovery.
See [subtitle acceptance](subtitle-sidecar-validation.md) for the executed matrix
and its limits. The Engine joint archive schema 3 is distinct from the library
envelope schema 2; the library version was not bumped.

Missing/truncated/ambiguous timeline maps reject derived subtitle/chapter exports.
Recording starts at the current window; latest-complete/PDT starts remain deferred.
The M4 local functional scope is closed; M5 has not started. Long-duration memory/resource measurements,
clean-checkout/platform release acceptance and the full migration guide remain
outside this round. Strict native Clippy has historical warnings and is not
reported as passing.
