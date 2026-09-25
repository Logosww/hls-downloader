# Writable output verification

Run after building Browser WASM:

```sh
pnpm --filter @hls-downloader/test exec playwright install chromium
pnpm run test:browser:writable
```

`HLS_TEST_CHROMIUM_PATH` may select an already installed Chromium executable.
The runner records its actual version in `test-results/writable-memory.json`.
CI installs the matching Playwright Chromium and uploads that report.

The two-segment smoke test writes an OPFS file, closes it, and plays it to
completion. Large runs discard output rather than collecting a Blob. They use
concurrency 3 and alternate the two synthetic TS fixtures with distinct query
URLs; these runs measure allocation, not timestamp continuity. Continuous
TS/fMP4/BYTERANGE correctness is independently checked with ffprobe in
`writable-output.integration.test.ts`.

## Local baseline (2026-09-19)

Chromium 148.0.7778.96, macOS arm64. Values are observed peaks, not a promised
fixed memory budget. Browser GC can change these figures between runs.

| Segments | Output bytes | JS heap peak | Heap at source-parsed | WASM high-water bytes |
| --- | --- | --- | --- | --- |
| 2 | 59565 | 15869844 | 15489599 | 1376256 |
| 100 | 2923664 | 26404185 | 15528571 | 1376256 |
| 1000 | 29226614 | 79895431 | 16497345 | 1638400 |
| 10000 | 292256114 | 154388218 | 19570866 | 6029312 |

The JS resource window independently asserts at most C in-flight/ready entries
for 100, 1,000 and 10,000 segments. One current segment, initialization data,
transmux scratch space and one pending output block are additional. Playlist
strings/objects grow with segment count. WASM linear memory does not shrink;
its high-water includes both playlist metadata and media processing. Heap
telemetry includes GC slack. Do not subtract these counters to claim exact
media-buffer bytes or treat them as total browser RSS.

The browser harness applies a generous growth regression threshold; the
resource-window assertions and stalled-writer HTTP test are the deterministic
backpressure checks. The Browser-only vendored hls-transmux patch prevents
unused mfra index accumulation. Its source/license and patch rationale live
beside the WASM crate; Node continues to use the registry dependency.

## App-web flow

After building the library, start `pnpm --filter @hls-downloader/app-web dev --port 3100`
and run `pnpm test:app-web:writable` in another terminal. Set `HLS_APP_WEB_URL`
for a different origin; `HLS_TEST_CHROMIUM_PATH` is also supported.

This test substitutes the file picker with an OPFS handle and uses real Browser
WASM plus local media fixtures. It verifies user activation, direct file output
without a Blob URL, queue isolation/cancellation, permission/write failures,
legacy manual save, and unsupported-browser mobile layout. Screenshots go to
`test-results/app-web-*.png`. Native OS picker dialogs remain a manual check.
