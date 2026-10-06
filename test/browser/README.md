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
concurrency 3 and repeat two synthetic TS fixtures with increasing PES timestamps
and distinct query URLs. Continuous
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
for 100, 1,000 and 10,000 segments. One current segment, one demuxed TS lookahead segment, initialization data,
transmux scratch space and one pending output block are additional. Playlist
strings/objects grow with segment count. WASM linear memory does not shrink;
its high-water includes both playlist metadata and media processing. Heap
telemetry includes GC slack. Do not subtract these counters to claim exact
media-buffer bytes or treat them as total browser RSS.

The browser harness applies a generous growth regression threshold; the
resource-window assertions and stalled-writer HTTP test are the deterministic
backpressure checks. Both Browser WASM and Node use the registry hls-transmux dependency. Since
0.4.2, upstream skips unused mfra index accumulation when write_mfra is false;
no local patch is needed.

## App-web flow

After building the library, start `pnpm --filter @hls-downloader/app-web dev --port 3100`
and run `pnpm test:app-web:writable` in another terminal. Set `HLS_APP_WEB_URL`
for a different origin; `HLS_TEST_CHROMIUM_PATH` is also supported.

This test substitutes the file picker with an OPFS handle and uses real Browser
WASM plus local media fixtures. It verifies user activation, direct file output
without a Blob URL, queue isolation/cancellation, permission/write failures,
legacy manual save, and unsupported-browser mobile layout. Screenshots go to
`test-results/app-web-*.png`. Native OS picker dialogs remain a manual check.

## 3.6.0 extension request-context acceptance

After building the library (`pnpm run build`), run:

```sh
HLS_EXTENSION_CHANNEL=chrome pnpm run test:browser:extension
HLS_EXTENSION_CHANNEL=msedge pnpm run test:browser:extension
```

The selected browser must be installed. With no channel override, the runner uses
Playwright's installed Chromium. `HLS_TEST_CHROMIUM_PATH` can override the executable;
when using it, set `HLS_EXTENSION_CHANNEL` to the browser's actual identity so reports
are correctly labelled. Each run uses a test-only profile under `test-results/extension`.
It enables extension debugging only in that profile and loads the unpacked extension
with CDP `Extensions.loadUnpacked` over Playwright's debugging pipe; it does not touch
the user's normal browser profile.

The runner installs locked WXT tooling in an isolated project, creates and extracts
actual `npm pack --ignore-scripts` tarballs for the root package and its three workspace
dependencies, then builds Chrome and Edge MV3 production outputs. It does not import
private source, patch node_modules, rewrite resource URLs, or replace global fetch.
Tarballs and built extensions remain in `test-results/extension` for inspection.

The extension page uses public `/core` and `/adapters/browser` entrypoints, local WASM
and an extension CSP with `wasm-unsafe-eval`. A controlled loopback server requires a
real HttpOnly session cookie, an Authorization header and a Referer applied by an
asynchronously installed `declarativeNetRequest` session rule. Every manifest/init/media
request must pass those checks. The rule is removed in `finally`. TS, fMP4 and byte-range
fixtures write to OPFS, and the test verifies completion and the MP4 signature. H.264
transcoding and fMP4 poster extraction exercise the WebCodecs media path as well.
OPFS validates FileSystemWritableFileStream behavior; native save-picker UI remains a
manual browser check and is not exercised by this fixture.

Reports are written to `test-results/extension/acceptance-<channel>.json`. Building an
Edge target or running Chromium is **not** equivalent to executing Edge acceptance.
Do not mark 3.6.0 ready for publication until both real-browser runs have passed.

### Local verification — 2026-10-03

- Chrome 154.0.8037.98 on macOS arm64: passed, including cookie/header/rule checks,
  TS/fMP4/Range OPFS output, H.264 transcode, poster extraction and local WASM.
- WXT 0.21.4: Chrome and Edge production builds passed; WASM is emitted as a local
  hashed asset without additional library configuration.
- Long-video Chrome regression: passed 2, 100, 1,000 and 10,000 segments; 10,000-segment
  output is 291,896,114 bytes, peak observed JS heap 180,690,432 bytes and WASM high-water
  6,029,312 bytes. These counters include metadata and GC slack; deterministic
  backpressure/resource-window tests provide the buffer-bound assertions.
- Edge 154.0.4258.53 on macOS arm64: passed using the actual Edge browser and the
  WXT Edge MV3 production output. All 17 media requests passed the Cookie,
  Authorization and extension-applied Referer checks. TS/fMP4/Range OPFS output,
  H.264 transcode, poster extraction and local WASM passed. Report:
  `test-results/extension/acceptance-msedge.json`.
- The real Chrome/Edge extension acceptance requirement is satisfied; the previous
  Edge release blocker is resolved. The per-channel JSON reports describe only
  their own run; a pending label for the other browser does not invalidate that
  browser's separate passing report.

References: [WXT entrypoints](https://wxt.dev/guide/essentials/entrypoints),
[WXT manifest configuration](https://wxt.dev/guide/essentials/config/manifest),
[Chromium extension debugging protocol](https://chromium.googlesource.com/chromium/src.git/+/225b2eaa7f23c33b7c4e30c1bfc58f1bd99cbe1c).

## App-web metadata cancellation

Run `pnpm run test:app-web:metadata` with an installed Playwright Chromium, or set
`HLS_TEST_CHROMIUM_PATH` to an installed Chrome executable. This standalone browser
fixture mounts the real metadata hook under React StrictMode and uses controlled
responses to cover replacement during parsing/poster reads, unmount during either
stage, late results, and optional poster failure. Cancelled operations return `null`;
actual parse failures return `false`, while valid metadata returns `true` even when
poster extraction fails. The page ignores cancelled results rather than opening a
confirmation or displaying a parsing error. The test runs in CI after the library build.

## Continuous recording

Run `pnpm test:browser:recording` from the repository root. If Playwright's bundled Chromium is unavailable, set `HLS_TEST_CHROMIUM_PATH` to an existing Chrome executable. The Node suite first writes `test-results/recording-native.json`; Chrome compares the 13 open-input profiles, verifies key-wait cancellation/late completion and sink-close errors, and exercises VOD pause with delayed resume, stop and cancellation.

`pnpm test:recording` also checks polling overlap, empty windows, source rewrites, explicit generation restart, GAP/configuration splits, capacity errors, Node publication and Blob conversion. The 8/64/256 repeated-input checks compare core queue/sample peaks and bounded mapping/output history, excluding caller-owned snapshots and collected bytes. These accelerated checks are not multi-hour RSS measurements.
