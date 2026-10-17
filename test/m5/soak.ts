import { parseArgs } from 'node:util';
import { fork } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { platform, arch, release } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';
import { startSource } from './source.ts';
import { realtimeWindow, segmentSeconds, Trend } from './realtime.ts';
import type { SoakConfig } from './soak-client.ts';
import { startVideoSource, videoSeconds } from './video-source.ts';

const { values } = parseArgs({
  options: {
    hours: { type: 'string' },
    seconds: { type: 'string' },
    runtime: { type: 'string', default: 'both' },
    playlist: { type: 'string', default: 'live' },
    'sample-seconds': { type: 'string', default: '15' },
    'stall-seconds': { type: 'string', default: '60' },
    'write-delay-ms': { type: 'string', default: '10' },
    out: { type: 'string' },
    workload: { type: 'string', default: 'aac' },
    'sink-stall-ms': { type: 'string', default: '0' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'M5 real elapsed recording (default 2 hours)\n' +
      '  --hours 2 | --seconds 15 (smoke only)\n  --runtime node|browser|both\n' +
      '  --playlist live|event\n  --sample-seconds 15 --stall-seconds 60 --write-delay-ms 10\n' +
      '  --workload aac|av --sink-stall-ms 0\n' +
      '  --out NEW_DIRECTORY\nRequires built Native SDK and generated WASM; av also requires FFmpeg with libx264. No publication.',
  );
  process.exit(0);
}
if (values.hours !== undefined && values.seconds !== undefined)
  throw Error('Choose --hours or --seconds');
function number(text: string, min: number, max: number, label: string) {
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max)
    throw Error(`Invalid ${label}: expected ${min}..${max}`);
  return n;
}
const durationMs =
  values.seconds !== undefined
    ? number(values.seconds, 5, 86400, 'seconds') * 1000
    : number(values.hours ?? '2', 5 / 3600, 24, 'hours') * 3_600_000;
const sampleMs = number(values['sample-seconds']!, 1, 60, 'sample-seconds') * 1000;
const stallTimeoutMs = number(values['stall-seconds']!, 5, 600, 'stall-seconds') * 1000;
const writeDelayMs = number(values['write-delay-ms']!, 0, 10000, 'write-delay-ms');
const sinkStallMs = number(values['sink-stall-ms']!, 0, 5000, 'sink-stall-ms');
if (
  !['node', 'browser', 'both'].includes(values.runtime!) ||
  !['live', 'event'].includes(values.playlist!) ||
  !['aac', 'av'].includes(values.workload!)
)
  throw Error('Invalid runtime/playlist');
if (sampleMs > durationMs / 4) throw Error('Use a sample interval <= one quarter of the duration');
const mode = values.playlist as 'live' | 'event';
const workload = values.workload as 'aac' | 'av';
const count = realtimeWindow(
  0,
  durationMs,
  mode,
  workload === 'av' ? 4 : 16,
  workload === 'av' ? videoSeconds : segmentSeconds,
).count;
const root = resolve(import.meta.dirname, '../..');
const output = values.out
  ? resolve(values.out)
  : join(
      root,
      'test-results/m5',
      `soak-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`,
    );
mkdirSync(resolve(output, '..'), { recursive: true });
mkdirSync(output); // Never overwrite previous acceptance evidence.
const requested = values.runtime === 'both' ? ['node', 'browser'] : [values.runtime!];
const abort = new AbortController();
let interrupted: string | undefined;
const signalHandlers = new Map(
  ['SIGINT', 'SIGTERM'].map((signal) => {
    const handler = () => {
      interrupted = signal;
      abort.abort(Error(signal));
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  }),
);
const started = performance.now();
const warmupMs = Math.min(60_000, durationMs / 3);
const trends = new Map<string, Map<string, Trend>>();
const latest: Record<string, any> = {};
const summary: any = {
  schemaVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  host: { platform: platform(), arch: arch(), release: release(), node: process.version },
  config: {
    durationMs,
    sampleMs,
    stallTimeoutMs,
    writeDelayMs,
    workload,
    sinkStallMs,
    warmupMs,
    playlist: mode,
    runtimes: requested,
    count,
    mediaSeconds: count * (workload === 'av' ? videoSeconds : segmentSeconds),
  },
  qualification:
    values.seconds === undefined && durationMs >= 7_200_000
      ? `multi-hour synthetic ${workload === 'av' ? '720p AVC + two AAC tracks + WebVTT' : 'AAC/WebVTT'} workload`
      : 'smoke only; not multi-hour acceptance',
  results: {},
};
// Fingerprint the harness and key SDK artifacts. Final release qualification
// still requires the complete source snapshot/immutable commit separately.
summary.sha256 = Object.fromEntries(
  [
    'test/m5/soak.ts',
    'test/m5/soak-client.ts',
    'test/m5/soak-native.ts',
    'test/m5/soak.html',
    'test/m5/source.ts',
    'test/m5/realtime.ts',
    'test/m5/video-source.ts',
    ...(requested.includes('node')
      ? [
          'dist/index.js',
          'packages/shared/dist/index.mjs',
          'packages/core/dist/index.mjs',
          'packages/adapters/dist/node.mjs',
          'packages/adapters/dist/native.js',
          ...readdirSync(join(root, 'packages/adapters/dist'))
            .filter((name) => name.endsWith('.node'))
            .map((name) => `packages/adapters/dist/${name}`),
        ]
      : []),
    ...(requested.includes('browser')
      ? [
          'packages/core/src/index.ts',
          'packages/adapters/src/multitrack.ts',
          'packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
        ]
      : []),
  ].map((file) => [
    file,
    createHash('sha256')
      .update(readFileSync(join(root, file)))
      .digest('hex'),
  ]),
);
function save() {
  writeFileSync(
    join(output, 'summary.tmp'),
    JSON.stringify({ ...summary, wallMs: performance.now() - started, latest }, null, 2) + '\n',
  );
  renameSync(join(output, 'summary.tmp'), join(output, 'summary.json'));
}
function sample(runtime: string, value: any) {
  if (!Number.isFinite(value.elapsedMs) || !Number.isFinite(value.committed))
    throw Error('Invalid sample');
  appendFileSync(join(output, 'samples.ndjson'), JSON.stringify({ runtime, ...value }) + '\n');
  latest[runtime] = value;
  if (value.elapsedMs >= warmupMs) {
    const fields = runtime === 'node' ? ['rss', 'heapUsed', 'external'] : ['heapUsed', 'wasmBytes'];
    if (!trends.has(runtime)) trends.set(runtime, new Map());
    for (const field of fields) {
      if (!Number.isFinite(value[field])) throw Error(`Missing ${field} measurement`);
      const stats = trends.get(runtime)!;
      if (!stats.has(field)) stats.set(field, new Trend());
      stats.get(field)!.add(value.elapsedMs, value[field]);
    }
  }
  save();
}
save();
console.log(
  `M5 ${summary.qualification}: ${durationMs / 1000}s, ${mode}, ${requested.join('+')}\nEvidence: ${output}`,
);
const deadline = setTimeout(
  () => abort.abort(Error('Overall recording deadline exceeded')),
  durationMs + 120_000,
);
const heartbeat = setInterval(
  () =>
    console.log(
      JSON.stringify({
        elapsedSeconds: Math.round((performance.now() - started) / 1000),
        progress: Object.fromEntries(
          Object.entries(latest).map(([k, v]) => [
            k,
            { committed: v.committed, cues: v.cues, state: v.state },
          ]),
        ),
      }),
    ),
  60_000,
);
let source: { origin: string; readonly requests: number; close(): Promise<void> } | undefined;
let preparedBrowser: Browser | undefined;
async function prepareBrowser() {
  const executablePath = process.env.HLS_TEST_CHROMIUM_PATH;
  let selection = executablePath ? `executable: ${executablePath}` : 'playwright-chromium';
  try {
    preparedBrowser = await chromium.launch({ executablePath, timeout: 30_000 });
  } catch (error) {
    // Only fall back for a missing bundled browser. Explicit paths and other
    // launch failures must remain visible rather than selecting another browser.
    if (executablePath || !String(error).includes("Executable doesn't exist")) throw error;
    selection = 'chrome';
    console.log('Playwright Chromium is not installed; trying installed Google Chrome.');
    try {
      preparedBrowser = await chromium.launch({ channel: 'chrome', timeout: 30_000 });
    } catch (chromeError) {
      throw Error(
        'Could not start installed Google Chrome. Run `pnpm --filter @hls-downloader/test exec playwright install chromium` ' +
          'or set HLS_TEST_CHROMIUM_PATH to a working Chrome executable.\n' +
          String(chromeError),
      );
    }
  }
  summary.browser = { selection, version: preparedBrowser.version() };
  console.log(`Browser: ${selection} (${summary.browser.version})`);
  save();
}
function config(runtime: string): SoakConfig {
  return {
    url: `${source!.origin}/${runtime}/master.m3u8`,
    count,
    durationMs,
    sampleMs,
    stallTimeoutMs,
    writeDelayMs,
    workload,
    sinkStallMs,
  };
}
async function native() {
  const cwd = join(output, 'native-work');
  mkdirSync(cwd);
  const log = openSync(join(output, 'native.stderr.log'), 'w');
  try {
    return await new Promise<any>((resolveResult, reject) => {
      const child = fork(
        resolve(import.meta.dirname, 'soak-native.ts'),
        [JSON.stringify(config('node'))],
        { cwd, execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', log, 'ipc'] },
      );
      let result: any,
        failure: Error | undefined,
        killTimer: ReturnType<typeof setTimeout> | undefined;
      let lastMessage = performance.now();
      const cancel = () => {
        if (child.connected) child.send('cancel', () => {});
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 10_000);
      };
      const watchdog = setInterval(() => {
        if (performance.now() - lastMessage > Math.max(30_000, sampleMs * 3)) {
          failure = Error('Native sampler stopped responding');
          cancel();
        }
      }, 1000);
      abort.signal.addEventListener('abort', cancel, { once: true });
      if (abort.signal.aborted) cancel();
      child.on('message', (message: any) => {
        lastMessage = performance.now();
        try {
          if (message.type === 'sample') sample('node', message.sample);
          else if (message.type === 'result') result = message;
          else if (message.type === 'error') {
            failure = Error(message.error);
            cancel();
          }
        } catch (error) {
          failure = error as Error;
          cancel();
        }
      });
      const cleanup = () => {
        clearInterval(watchdog);
        clearTimeout(killTimer);
        abort.signal.removeEventListener('abort', cancel);
      };
      child.on('error', (error) => {
        cleanup();
        reject(error);
      });
      child.on('exit', (code, signal) => {
        cleanup();
        if (failure || code !== 0 || !result || abort.signal.aborted)
          reject(failure ?? Error(`Native incomplete: ${code}/${signal}`));
        else resolveResult(result);
      });
    });
  } finally {
    closeSync(log);
  }
}
async function browser() {
  const server = await createServer({
    root,
    configFile: false,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    optimizeDeps: { entries: ['test/m5/soak.html'] },
    resolve: { alias: { '@hls-downloader/shared': join(root, 'packages/shared/src/index.ts') } },
    plugins: [
      {
        name: 'soak-wasm',
        configureServer(s) {
          s.middlewares.use((req, res, next) => {
            if (!req.url?.endsWith('hls_transmux_browser_wasm_bg.wasm')) return next();
            res.setHeader('Content-Type', 'application/wasm');
            res.end(
              readFileSync(
                join(
                  root,
                  'packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
                ),
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const browser = preparedBrowser!;
    let forceClose: ReturnType<typeof setTimeout> | undefined;
    let page: Page;
    const cancel = () => {
      void page?.evaluate(() => (window as any).soak?.cancel()).catch(() => {});
      forceClose ??= setTimeout(() => void browser.close().catch(() => {}), 10_000);
    };
    abort.signal.addEventListener('abort', cancel, { once: true });
    let pageError: string | undefined;
    try {
      page = await browser.newPage();
      page.on('pageerror', (error) => {
        pageError = error.message;
        cancel();
      });
      await page.goto(server.resolvedUrls!.local[0] + 'test/m5/soak.html');
      await page.waitForFunction(() => typeof (window as any).soak === 'object');
      if (abort.signal.aborted) throw abort.signal.reason;
      const cdp = await page.context().newCDPSession(page);
      await page.evaluate((config) => (window as any).soak.start(config), config('browser'));
      let sampling = true,
        samplerFailure: unknown;
      let lastSample = performance.now();
      const watchdog = setInterval(() => {
        if (performance.now() - lastSample > Math.max(30_000, sampleMs * 3)) {
          samplerFailure = Error('Browser sampler stopped responding');
          cancel();
        }
      }, 1000);
      const collect = async () => {
        const [heap, metrics] = await Promise.all([
          cdp.send('Runtime.getHeapUsage'),
          page.evaluate(() => (window as any).soak.snapshot()),
        ]);
        sample('browser', { ...metrics, heapUsed: heap.usedSize, heapTotal: heap.totalSize });
        lastSample = performance.now();
      };
      const samplerAbort = new AbortController();
      const sampler = (async () => {
        while (sampling) {
          await collect();
          await new Promise<void>((resolveWait) => {
            const done = () => {
              clearTimeout(timer);
              samplerAbort.signal.removeEventListener('abort', done);
              resolveWait();
            };
            const timer = setTimeout(done, sampleMs);
            samplerAbort.signal.addEventListener('abort', done, { once: true });
            if (samplerAbort.signal.aborted) done();
          });
        }
      })().catch((error) => {
        samplerFailure = error;
        cancel();
      });
      let result;
      try {
        result = await page.evaluate(() => (window as any).soak.result());
      } catch (error) {
        throw samplerFailure ?? (pageError ? Error(pageError) : error);
      } finally {
        sampling = false;
        samplerAbort.abort();
        await sampler;
        clearInterval(watchdog);
      }
      if (samplerFailure || pageError || abort.signal.aborted)
        throw samplerFailure ?? Error(pageError ?? 'Interrupted');
      await collect();
      await cdp.send('HeapProfiler.collectGarbage');
      const afterGc = await cdp.send('Runtime.getHeapUsage');
      return { version: browser.version(), result, afterGc };
    } finally {
      clearTimeout(forceClose);
      abort.signal.removeEventListener('abort', cancel);
    }
  } finally {
    await server.close();
  }
}
try {
  // Resolve and launch the browser before starting either recording, so a
  // missing executable cannot be mistaken for a Native recording failure.
  if (requested.includes('browser')) await prepareBrowser();
  if (abort.signal.aborted) throw abort.signal.reason;
  source =
    workload === 'av'
      ? await startVideoSource(join(output, 'video-fixtures'), durationMs, mode)
      : await startSource(count, 16, undefined, { durationMs, mode });
  const results = await Promise.allSettled(
    requested.map(async (runtime) => {
      try {
        summary.results[runtime] = await (runtime === 'node' ? native() : browser());
        save();
      } catch (error) {
        summary.results[runtime] = { error: String(error) };
        console.error(`[${runtime}] ${String(error)}`);
        abort.abort(error);
        throw error;
      }
    }),
  );
  summary.trends = Object.fromEntries(
    [...trends].map(([runtime, fields]) => [
      runtime,
      Object.fromEntries(
        [...fields].map(([field, trend]) => [
          field,
          trend.result((field === 'rss' ? 64 : 32) * 1024 ** 2),
        ]),
      ),
    ]),
  );
  if (results.some((r) => r.status === 'rejected'))
    throw Error('One or more runtimes failed; see results');
  if (
    requested.some((runtime) => !trends.has(runtime)) ||
    [...trends.values()].some((fields) =>
      [...fields].some(
        ([field, trend]) => !trend.result((field === 'rss' ? 64 : 32) * 1024 ** 2).passed,
      ),
    )
  )
    throw Error('Insufficient samples or resource growth exceeded screening limits');
  summary.status = 'passed';
} catch (error) {
  summary.status = interrupted ? 'interrupted' : 'failed';
  summary.error = String(error);
  console.error(summary.error);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} finally {
  clearTimeout(deadline);
  clearInterval(heartbeat);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  summary.finishedAt = new Date().toISOString();
  summary.sourceRequests = source?.requests;
  await preparedBrowser?.close();
  await source?.close();
  save();
  console.log(`${summary.status}: ${join(output, 'summary.json')}`);
}
