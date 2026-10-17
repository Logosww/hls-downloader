# M5 acceptance — closed 2026-10-17

M5 was **manually closed on 2026-10-17** at the user's explicit direction after
they confirmed acceptance had completed on other machines. This closes the
remaining M5 test gates by user confirmation. External raw logs, host inventory
and artifact hashes have not been imported into this workspace; no automated
`passed` reports were fabricated and no fresh local long-run/platform acceptance
is claimed by this closure.

Migration guides remain deferred at the user's request, not delivered. Source
versions remain 3.9.0. This closure does not bump versions, push commits, create
tags or publish packages/releases. The planned public release remains 4.0.0 stable.

The records below preserve the local work and evidence from 2026-10-13. Any
historical references to pending runs describe the state before this closure.

## Executed in this round

| Gate                         | Evidence                                                                | Scope                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Rolling encrypted subtitles  | `m5-rolling.integration.test.ts`: 6 passed                              | Native/WASM accept unchanged keys after snapshot declaration renumbering; actual URI/IV rewrites reject |
| Subtitle/recovery regression | 52 passed including the six new cases                                   | Includes joint Live/EVENT recovery; replay and live admission use the same identity comparison          |
| Full library regression      | 757 passed, 5 environment-gated skips                                   | Local macOS arm64; subsets overlap this total                                                           |
| Resource probe               | `resources.ts` / `native.ts` / `browser.html`                           | See resource evidence below; accelerated rolling input, not overnight qualification                     |
| Independent source build     | `/tmp/hls-m5-clean-source`, hash manifest and logs in `test-results/m5` | Frozen-lock install, fresh Native/WASM and library build, then 15 tarball tests passed                  |

The source copy included the current uncommitted M4/M5 library implementation and
nonignored fixtures. It contained no `node_modules`, `dist`, `.node`, WASM binary
or Rust `target` cache. Native compilation used this Mac's dynamic FFmpeg
libraries. Offline install first failed because registry metadata was unavailable;
normal frozen-lock installation then passed without changing the lockfile.
This is an independent **working-source snapshot**, not an immutable release
commit, hermetic build or six-platform static-package qualification.

## Gate scripts (retained for reruns)

Authoring verification on 2026-10-13: all four local smoke gates and isolated
dynamic-package installation passed; 13 clock/matrix/rolling regression tests,
strict TypeScript, lint and formatting checks passed. The dirty-candidate and
dynamic-linkage rejection paths were exercised. See the
[retained smoke evidence](evidence/remaining-gates-smoke-2026-10-13.json).

Use Node 24+ to execute the TypeScript harnesses, a built Native library and generated
WASM, FFmpeg/ffprobe on PATH (with libx264 for video stress), and either Playwright
Chromium or installed Chrome. These scripts never publish packages or modify the
roadmap automatically. Start from the repository root:

```sh
# Short wiring checks: EVENT, recovery/faults, video stress, three classic sizes.
pnpm test:m5:gates --gate local --smoke

# Real elapsed recording gates, each independently recorded.
pnpm test:m5:gates --gate event --hours 2
pnpm test:m5:gates --gate recovery --hours 2
pnpm test:m5:gates --gate stress --hours 2

# Three classic MP4 sizes, with independent probe/decode and index assertions.
pnpm test:m5:gates --gate classic

# Run all four above sequentially (more than six hours with defaults).
pnpm test:m5:gates --gate local --hours 2

# Current host: prebuilt static binary, isolated package installation and runtime.
pnpm test:m5:gates --gate platform
# Local dynamic-build wiring only, explicitly excluded from the static matrix.
pnpm test:m5:gates --gate platform --smoke

# After reviewing/committing the candidate and making the checkout clean.
pnpm test:m5:gates --gate candidate
```

`--gate` is required to start work; no arguments or `--help` prints usage. `--hours`
accepts 2–24; `--smoke` selects short workloads and cannot qualify long runs.
`--out NEW_DIRECTORY` saves a unique evidence tree without overwriting older runs.
Each subprocess has a log, exit status and deadline. Interrupts stop owned process
groups (process trees on Windows), retain partial evidence and exit 130/143.
Failed children, missing evidence and missing prerequisites fail the command;
there is no skip-as-pass path. Outer summaries link and hash the child summaries.

| Gate | Script and assertions | Qualification boundary |
| --- | --- | --- |
| EVENT | `soak.ts --playlist event`: real-time cumulative manifests, complete media/cues, sink closure and resource trends on Native/Chrome | Requires an actual multi-hour pass; the previous Live run does not close it |
| Recovery/faults | `recovery.ts` / `recovery-worker.ts`: same Live file/checkpoint across repeated SIGKILL (every 300 s), transient HTTP 503s, journal size sampling, independent AAC decode/frame count, ordered unique cues, offline terminal resume, no partial or stray files | Uses synthetic encrypted AAC/WebVTT; follows the long run with an accelerated 64 KiB EVENT replay-budget exhaustion check, requiring `RESOURCE_LIMIT_EXCEEDED` / `RecoveryReplayBudget` after media progress |
| Video stress | `soak.ts --workload av`: 1280×720 AVC at about 4 Mbit/s, two external 128 kbit/s AAC tracks, WebVTT, 10 ms writes and periodic 500 ms sink stalls; requires all three media tracks and complete per-input counts | Real Native and Chrome, aggregate resource screens; this is synthetic input and discarded fMP4 output, not a new player-compatibility certification |
| Classic indexes | `classic.ts`: 256/512/1024 segments, ffprobe duration and full ffmpeg decode, exactly 17 AAC index samples per segment, RSS/heap and file size | Records the measured scaling; public supported limits still require documentation review |
| Platform/install | `platform.ts`: matching host binary, system-library-only linkage check, locally packed platform package, library tarballs without adjacent `.node`, isolated npm optional-dependency installation, actual Native media processing, exports/types/WASM, missing optional dependency and unsupported-OS rejection | Run on each of six real hosts; `--smoke`/`--allow-dynamic` is never static evidence. Loader OS rejection is simulated; supported hosts execute real binaries |
| Candidate | `candidate.ts`: rejects a dirty tree, clones exact HEAD to a fresh checkout, frozen-lock install/build, full library and tarball tests with zero skips/todos, Rust recovery contracts, real-browser suites, Bun tests and player verification | Requires Rust/WASM tooling, Bun, Python/player prerequisites. Certifies this checkout/host only; six-platform and long-run evidence remain separate |

Video fixtures are regenerated into the run directory with FFmpeg. Each fragment
spans exactly 2.56 s (64 video frames, 120 AAC frames); fixture durations are probed
before use. The source rewrites fragment decode timestamps, publishes on a
monotonic clock and retains a constant number of media templates. A four-segment
initial window advances two segments every 5.12 s. The existing AAC workload
remains the default. `--sink-stall-ms` allows 0–5000 ms on the direct soak command.

Recovery evidence includes per-process RSS/heap/descriptors, checkpoint and
journal sizes in `samples.ndjson`, final media/subtitles, retained state and the
expected budget-failure checkpoint. At least two crashes and one HTTP failure
must actually occur. Progress and worker response watchdogs prevent hangs.
The exhaustion probe is accelerated; its pass does not claim a separate
multi-hour EVENT recovery run. For direct tuning, use
`pnpm --filter @hls-downloader/test exec node m5/recovery.ts --hours 2 --crash-seconds 300`.
Classic sizes can likewise be tuned with
`pnpm --filter @hls-downloader/test exec node m5/classic.ts --segments 512,1024,2048`.

### Six-platform workflow and evidence merge

[`.github/workflows/m5-acceptance.yml`](../../.github/workflows/m5-acceptance.yml)
is a manual, read-only-permissions workflow. It builds static FFmpeg/Native for
Linux x64/arm64, macOS x64/arm64 and Windows x64/arm64 on matching hosts, builds
WASM and library distributions via `build-platform.ts`, then runs platform acceptance
and uploads logs/tarballs/summary. It has no npm publish, release or tag step.
It has been authored locally; the six-host workflow has not been executed here.

`platform.ts` stages copies of package manifests/distributions, replaces local
workspace specs with their version and points the current optional native
package at its local tarball. npm installs into a directory outside the repository;
source package manifests and binaries are never stripped or rewritten. The
consumer location is retained in `consumerRoot` for debugging. This verifies local
tarball routing; registry publication metadata still needs release review.

Download the six `platform-final/summary.json` artifacts, then merge them:

```sh
pnpm test:m5:gates --gate matrix \
  --inputs /path/linux-x64/summary.json --inputs /path/linux-arm64/summary.json \
  --inputs /path/darwin-x64/summary.json --inputs /path/darwin-arm64/summary.json \
  --inputs /path/windows-x64/summary.json --inputs /path/windows-arm64/summary.json
```

The merge requires six distinct targets at one immutable commit, clean source,
static linkage, completed required checks and binary hashes. Missing, duplicated,
failed, dynamic or smoke evidence rejects the merge. Node/Bun/browser version
coverage, player constraints and migration documentation remain explicit release
review items; a merged platform matrix does not automatically complete M5.

## Real elapsed multi-hour recording

The migration-guide documents and their navigation links were removed at the
user's request. Migration documentation is deferred; it is no longer a completed
deliverable of this round.

Build the library distributions and generated WASM first. Browser startup uses
`HLS_TEST_CHROMIUM_PATH` when set; otherwise it tries Playwright Chromium and,
if that bundled executable is missing, the installed Google Chrome channel.
The selected browser and version are printed and recorded in `summary.json`.
Run from the repository root:

```sh
# Default: both Native and Chrome concurrently, real elapsed 2 hours, Live.
pnpm test:m5:soak

# Explicit overnight example; EVENT is a separate acceptance run.
pnpm test:m5:soak --hours 8 --runtime both --playlist live
pnpm test:m5:soak --hours 2 --runtime both --playlist event

# Fast wiring/lifecycle verification, always labeled smoke-only.
pnpm test:m5:soak --seconds 12 --sample-seconds 1
```

If neither browser is installed, run
`pnpm --filter @hls-downloader/test exec playwright install chromium`, or set
`HLS_TEST_CHROMIUM_PATH` to a working Chrome executable. An explicit path never
silently falls back. Browser launch is checked before either recording starts;
startup and runtime errors are printed to stderr as well as saved in the summary.
`--runtime node` requires no browser. Keep the process and machine running during
acceptance: sleep or a stalled browser can cause a missed live window and a
failure. This command does not detach, schedule work, or publish anything.

Options:

| Option             | Default                                   | Meaning                                                                           |
| ------------------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `--hours`          | `2`                                       | Real elapsed duration, up to 24 hours; mutually exclusive with `--seconds`        |
| `--seconds`        | unset                                     | Short verification; always classified as smoke, even when given a large number    |
| `--runtime`        | `both`                                    | `node`, `browser`, or both concurrently                                           |
| `--playlist`       | `live`                                    | `live` rolling window or cumulative `event`                                       |
| `--sample-seconds` | `15`                                      | 1–60 seconds, at most one quarter of the requested duration                       |
| `--stall-seconds`  | `60`                                      | Fail if committed media stops advancing for this duration                         |
| `--write-delay-ms` | `10`                                      | Awaited delay for each media and subtitle write; may be increased for fault tests |
| `--out`            | unique `test-results/m5/soak-*` directory | Must not already exist; previous evidence is never overwritten                    |

`source.ts` now has an explicit real-time mode. A monotonic clock starts on the
first media/subtitle playlist request of each runtime. A 16-segment initial
window is followed by eight new segments every 3.158 seconds, matching the
synthetic AAC media clock. Repeated requests never advance publication. ENDLIST
appears only after the requested elapsed duration and the final scheduled batch;
completion may be a few seconds later. The initial window adds about 6.32 seconds
to recorded media. Live drops old entries; EVENT keeps the entire published
playlist and its inherent manifest growth is included in library measurements.

The default AAC workload uses AES-128 Packed AAC plus AES-128 WebVTT, alternating synthetic
key bytes under per-segment key URIs, sequence IVs, request jitter and slow media/
subtitle sinks. It deliberately discards media output, using fMP4 Writable, and
does not test classic MP4 indexing, realistic video bitrate, extra audio tracks,
crash recovery or every encryption profile. Growing EVENT manifests can exhaust
the configured library budgets; such a run remains a failure, not an automatic pass.

Evidence is written throughout the run:

- `summary.json`: starts as `running`, atomically updated with latest progress;
  finishes `passed`, `failed` or `interrupted`, with configuration and code/artifact hashes.
- `samples.ndjson`: append-only raw samples; Native RSS/JS heap/external bytes/file
  descriptors and Chrome JS heap/WASM capacity plus committed media/cue/byte counters.
- `native.stderr.log` and `native-work/`: child diagnostics and isolated working
  directory; unexpected leftover recording files fail acceptance and are preserved.

The harness keeps only the latest sample and constant-space trend accumulators
in memory. After a warm-up of 60 seconds (one third of the duration for short
runs), it reports min/max, baseline growth and linear slope in bytes/hour.
The baseline growth alarms remain 64 MiB for Native RSS and 32 MiB for JS heap,
external bytes and WASM capacity; at least two post-warm-up samples are required.
These are screening thresholds for this workload, not universal library memory
limits. Slope is reported for review, not used as a noisy short-run pass criterion.

Success requires real elapsed duration, EOF, every expected media segment and
subtitle cue, closed sinks, nonoverlapping writes, bounded Engine history/queues,
no classic indexes, and Native completion cleanup. A progress watchdog, sampler
watchdog and duration + 120-second outer deadline stop hung runs. Runtime failure
cancels the other runtime. Ctrl-C/SIGTERM cancels work, allows bounded cleanup,
then force-closes remaining workers/browser if necessary; exit codes are 130/143.
Hard process termination may leave a `running` summary: that is incomplete, never
successful acceptance. No automatic retry overwrites failed evidence.

Executed on 2026-10-13: 12-second Live and EVENT smoke runs passed on Native and
Chrome; SIGINT retained partial samples with `interrupted`/130; an injected
10-second write delay with a 5-second progress timeout produced `failed`/1.
The clock/trend unit tests and existing rolling regressions passed (9 tests).
See the [smoke evidence summary](evidence/soak-smoke-2026-10-13.json).
Browser-startup follow-up: the root command with `HLS_TEST_CHROMIUM_PATH` unset
passed a 12-second Native + Chrome run via the installed-Chrome fallback
(`test-results/m5/soak-2026-10-13T06-10-04.470Z-bfc58a3b`). An invalid explicit
executable failed before either recording started, retained `summary.json`, and
printed the launch error with exit code 1.
The subsequent user-run **two-hour Live acceptance passed** on 2026-10-13:
[raw summary](../../test-results/m5/soak-2026-10-13T06-48-23.662Z-4442435e/summary.json).
On macOS arm64, Native (Node 26.11.1) and Chrome 155.0.8059.40 recorded for
7200.45 and 7200.80 seconds respectively (7203.55 seconds total wall time).
Both committed all 18,256 media segments and 18,256 subtitle cues, reached EOF,
and closed both sinks with the configured 10 ms write delay. All resource
screens passed with 477 post-warm-up samples per metric: maximum growth over
the warm-up baseline was 4.49 MiB for Native RSS and 0.78 MiB for Chrome JS heap;
WASM capacity stayed at 1.44 MiB with zero growth. Native cleanup passed with
no leftover recording files. Raw samples and code/artifact hashes are retained
alongside the summary. This closes the two-hour synthetic Live workload on
this host; at that time, multi-hour EVENT and the remaining release gates were still open.
They were subsequently closed by the user confirmation recorded above.

## Reproduce the accelerated resource measurements

Retained summary: [2026-10-13 measurements](evidence/2026-10-13.json), including
SHA-256 references to the raw local JSON. Node 26.11.1 and Chrome 155.0.8059.40
ran on macOS arm64. All four runs passed the stated screening thresholds.

| Output/runtime       | Segments / media seconds | Measured wall seconds | Memory / index observation                                                                                                        |
| -------------------- | ------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Native fMP4 Writable | 2048 / 808.43            | 260.86                | Peak RSS 114.77 MiB; later RSS growth 19.03 MiB; descriptor count 17 before and after eight cancellations                         |
| Chrome fMP4 Writable | 2048 / 808.43            | 262.39 (last sample)  | Peak JS heap 14.23 MiB; WASM capacity 1.44 MiB with zero later growth; retained heap after eight cancellations increased 0.32 MiB |
| Native classic MP4   | 256 / 101.05             | 30.86                 | 4,352 index samples, peak RSS 87.20 MiB; independent AAC probe and full decode passed                                             |
| Native classic MP4   | 512 / 202.11             | 63.60                 | 8,704 index samples, peak RSS 116.32 MiB; independent AAC probe and full decode passed                                            |

Each successful run committed one subtitle cue per media segment. Writable
outputs reported zero classic-index samples. RSS differences between processes
include runtime/allocator noise; only the sample-index count establishes the
expected scaling here. An earlier Chrome attempt was invalidated by Vite hot
reload and is excluded. The completed probes disable HMR/watch and retain failure
status if a future run fails.

Build library distributions first. Native runs in a separate child process using
the built public entrypoint; real Chrome loads the source Browser adapter and
the generated WASM through Vite. Never compare stale Native distributions with
changed source. All servers bind loopback only; output media is temporary.

```sh
HLS_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test:m5:resources
HLS_M5_SEGMENTS=256 HLS_M5_RUNTIME=node HLS_M5_FORMAT=mp4 pnpm test:m5:resources
HLS_M5_SEGMENTS=512 HLS_M5_RUNTIME=node HLS_M5_FORMAT=mp4 pnpm test:m5:resources
```

The default is 2048 segments per runtime. `HLS_M5_SEGMENTS` must be a multiple of
16, at least 32. `HLS_M5_RUNTIME` is `node`, `browser` or `both`;
`HLS_M5_FORMAT` selects Native `writable`, `mp4` or `fmp4`. Browser always uses
Writable. Omit the Chrome executable variable to use Playwright's installed
Chromium. JSON results are saved under `test-results/m5/resources-*.json`.

The source generates overlapping 16-segment rolling windows, advances by eight
segments and ultimately adds ENDLIST. Each segment contains 17 independent
fixture AAC frames with a fresh ID3 clock; its AES-128 key has a distinct URI
(public synthetic key bytes stay constant). AES-128 WebVTT has a unique cue per
segment. There is periodic request jitter, 2 ms media writes, 1 ms subtitle
writes, bounded report history and eight cancellation operations in concurrent
pairs. Neither the source nor the sink retains media or request logs.

Measure Node RSS, heap and external bytes, and Chrome CDP heap plus the actual
WASM linear-memory capacity. Check sink closure, committed segments/cues,
nonoverlapping writes, queue/history bounds and descriptors before/after
cancellation. Classic output additionally goes through ffprobe and full FFmpeg
decode. WASM capacity is not live allocation and normally does not shrink;
CDP heap is not browser process RSS. Node external bytes are not total Rust
allocations; RSS includes them and allocator retention.

Discard the first third of samples for the regression screen: maximum later
growth from that baseline must stay below 64 MiB RSS and 32 MiB heap/external/
WASM. These fixed alarms and a passing accelerated run **do not prove** constant
memory or absence of long-term leaks. Raw samples must be inspected across longer
wall-clock runs and higher-bitrate/multiple-track inputs. Classic sample indexes
are expected to grow and must be reported separately from streaming state.

## Reproduce independent source acceptance

```sh
node test/m5/snapshot.ts
# In the printed directory:
pnpm install --frozen-lockfile
pnpm run build
pnpm test:publish
```

`test:publish` only packs/inspects local tarballs and runs consumers; it does not
publish. `snapshot.ts` includes current nonignored new files, excludes tracked
deletions and records the base commit and each source SHA-256. After freezing the
candidate, repeat from an actual clean checkout of that commit. Verify the
published layout separately: the local acceptance includes a nearby native
binary and does not prove installation of platform optional dependencies.

## Gate closure record — 2026-10-17

All gates below are closed manually based on the user's confirmation of
acceptance on other machines. The closure is not a replacement for raw machine
reports; local historical evidence retains its original scope.

| Gate | Status |
| --- | --- |
| Real elapsed long recording (including EVENT) | Closed — user-confirmed external acceptance |
| Long recovery/resource faults | Closed — user-confirmed external acceptance |
| Real-time video/multi-track Browser stress | Closed — user-confirmed external acceptance |
| Classic index scaling | Closed — user-confirmed external acceptance |
| Six native targets | Closed — user-confirmed external acceptance |
| Platform package installation | Closed — user-confirmed external acceptance |
| Final candidate | Closed — user-confirmed external acceptance |

Historical strict native Clippy warnings are not reported as passing by this round.

See the existing [Engine matrix](../engine-1.0-validation.md),
[subtitle matrix](../subtitle-sidecar-validation.md) and [player evidence](../players/README.md).
Their M4 dates/scopes remain historical; this round does not retroactively turn
them into M5 platform release evidence. No release date or version bump closes a gate.
