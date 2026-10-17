# AES-128 WebVTT and continuous sidecar acceptance

Measured 2026-10-10 on macOS arm64, Node 26.11.1, registry `hls-engine = "=1.0.2"`
(upstream `6a107c7`). Native N-API, WASM and library outputs were rebuilt. No local
Engine patch, library version bump or publication. M5 has not started.

## Delivered contract

- `subtitleTracks[].sidecar`: acknowledged `writable` / per-output `writables` on
  Native and Browser, plus Node `file` with a deterministic media file output.
- `embedded` defaults to true; false requires a sidecar. Split factories receive
  lossless `inputId` / decimal `outputIndex`, close each output and use local time.
- AES-128 segment and MAP reads use the Engine operation key/resource session.
  Implicit IV uses the original sequence, and rotation is respected. Unsupported
  SAMPLE-AES/CTR/GCM WebVTT rejects explicitly; player gates remain unchanged.
- `subtitleCommit` exposes actual cue portions, receipts, identities, range/late
  dispositions and commit frontiers. It is observational; sink writes supply
  backpressure. Result completion follows both media and sidecar close.
- Node joint recovery retains library envelope schema 2 with Engine archive schema 3.
  Every selected subtitle must have a fixed file when sidecar recovery is enabled.
  Stable key versions and freshly read subtitle resources bind recovery replay.
- Finite exports accept `decryption` and `maxBytes` (16 MiB default). Mapped export
  requires a complete, unambiguous map and does not download primary media again.

## Executed matrix

`subtitle-sidecars.integration.test.ts`: **46 passing tests**. Native/WASM cases
use real shared Rust builds, not mocked Engine results.

| Area | Evidence |
| --- | --- |
| AES resources | Both runtimes × segment-only/encrypted MAP × embedded/sidecar-only; sequence 41/42 IVs, key rotation, selected language only, identical cues within one resource retained |
| Timing and contents | ffprobe supplies independent wvtt packet boundaries/times; a separate BMFF reader extracts payloads and compares cue multiplicity and floored-ms intervals against sidecar text |
| Continuous completion | Live/EVENT stop drains on both runtimes; slow close blocks success; empty windows emit one header and close |
| Failure/backpressure | Write and close failures reject; blocked-write cancel does not wait or later succeed; cancelled factory acquisition aborts a late writer; sample and collection limits reject |
| Range/split | Range-clipped output, excluded cues with `RejectedRange` commit evidence; discontinuity/configuration split closes two factories and rebases the second caption |
| Fixed paths | With/without resume; existing unrelated subtitle file remains intact; classic MP4/fMP4 split subtitle children publish alongside media |
| Recovery | Interrupted classic/fMP4 equals uninterrupted VTT exactly; stable-key version conflict, changed destination, corrupted subtitle prefix and uncommitted tail checks; completed task restores offline |
| Crash/live recovery | Actual child-process SIGKILL after a committed sidecar prefix; Live/EVENT interruption, replay, stop and final publication. Async subtitle replay finishes before fresh media polling starts |
| Finite export | AES `downloadSubtitles` and mapped `downloadSubtitleOutputs`, no primary `.m4s` reads for mapped export, explicit collection-cap failures |
| Rejection | SAMPLE-AES, SAMPLE-AES-CTR and AES-256-GCM subtitle resources reject on both runtimes |

Full library regression: **751 passed, 5 conditional tests skipped** (28 files passed,
2 skipped). The opt-in publish-entrypoint and player-fixture generation suites were
not enabled in this run. Public multi-track, recovery, decryption and timeline type
checks passed. The independent Rust Engine contract suite passed **3 tests**.
Ten changed English/Chinese MDX documents compiled; edited source lint and whitespace
checks passed. Earlier failed runs are not counted as acceptance: an asynchronous
Live replay race was fixed; stale rejection assertions and incomplete local artifact
copies were corrected before the final run.

## Real Chrome

`browser/subtitle-sidecars-smoke.ts` passed on **Chrome 155.0.8059.40**:

- AES MAP/rotation with both embedding modes, slow Writable acknowledgement and
  commit frontiers; output videos actually decoded frames and reached `ended`.
- Finite encrypted subtitle export.
- Cancellation during a blocked sidecar write; late acknowledgement did not close
  the output or change the `ABORTED` result.

Local raw evidence: `test-results/subtitle-sidecars-chrome.json` (ignored generated
artifact). This test verifies media playback and subtitle output data; it does not
claim Chrome renders embedded wvtt. The separate [target-player record](players/README.md)
retains Safari/AVFoundation, Chrome, IINA, VLC and Shaka measurements and limitations.

## Reproduce

Build Native/WASM and TypeScript, then copy native/WASM runtime assets and regenerate
the adapters barrel before testing child-process consumers. On this machine the
Native build uses `FFMPEG_DIR=/opt/homebrew/opt/ffmpeg`.

```sh
pnpm --filter @hls-downloader/test test:subtitles
pnpm --filter @hls-downloader/test exec vitest run --maxWorkers=4
pnpm run test:types:multitrack
FFMPEG_DIR=/opt/homebrew/opt/ffmpeg cargo test --manifest-path packages/adapters/src/node/crates/core/Cargo.toml --test engine_upstream
HLS_TEST_CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" pnpm --filter @hls-downloader/test test:browser:subtitles
```

## Limits retained

Continuous subtitles support plain text and standard cue settings, not arbitrary
STYLE/REGION or rich markup. A cue can be emitted in multiple committed portions;
millisecond-empty portions are omitted. Writable bytes cannot be rolled back, and
multiple final files do not publish atomically. Borrowed single sinks cannot split;
Browser/Writable/factory persistent recovery remains unsupported.

Replay metadata is bounded by `limits.queuedMetadataBytes` (default 4 MiB). It is not
an indefinitely growing journal: exhaustion fails with `RESOURCE_LIMIT_EXCEEDED`.
Long-duration memory/resource measurements and full cross-platform/clean-checkout
release acceptance belong to M5 and were not performed. Latest-fragment/PDT recording
starts remain deferred. No player capability was broadened by the AAC patch or this
subtitle bridge.
