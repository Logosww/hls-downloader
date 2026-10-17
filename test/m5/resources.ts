import { createServer } from 'vite';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { platform, arch, release } from 'node:os';
import { startSource, segmentSeconds } from './source.ts';

const root = resolve(import.meta.dirname, '../..');
const count = Number(process.env.HLS_M5_SEGMENTS ?? 2048);
const mode = process.env.HLS_M5_RUNTIME ?? 'both';
const format = process.env.HLS_M5_FORMAT ?? 'writable';
if (!Number.isSafeInteger(count) || count < 32 || count % 16)
  throw Error('HLS_M5_SEGMENTS must be a multiple of 16 >= 32');
if (!['both', 'node', 'browser'].includes(mode) || !['writable', 'mp4', 'fmp4'].includes(format))
  throw Error('Invalid runtime/format');
const source = await startSource(count);
const evidence: any = {
  date: new Date().toISOString(),
  host: { platform: platform(), arch: arch(), release: release() },
  scope:
    'Accelerated rolling Live -> ENDLIST; AES-128 Packed AAC and WebVTT, per-segment key identities, slow sinks and jitter. Not a real-time overnight soak or platform release qualification.',
  count,
  mediaSeconds: count * segmentSeconds,
  batch: 16,
  results: {},
};
function screen(samples: any[], fields: string[]) {
  // Ignore allocator/compilation warm-up. Fixed tolerances are regression alarms,
  // not a proof of constant space; retain every raw sample for trend analysis.
  const tail = samples.slice(Math.floor(samples.length / 3));
  return Object.fromEntries(
    fields.map((field) => {
      const values = tail.map((s) => s[field]);
      const growth = Math.max(...values) - values[0];
      const limit = field === 'rss' ? 64 * 1024 ** 2 : 32 * 1024 ** 2;
      return [field, { growthBytes: growth, limitBytes: limit, passed: growth <= limit }];
    }),
  );
}
try {
  if (mode !== 'browser') {
    console.log(`Native ${format}: ${count} generated segments`);
    evidence.results.node = await new Promise((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--expose-gc',
          resolve(import.meta.dirname, 'native.ts'),
          source.origin,
          String(count),
          format,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let stdout = '';
      child.stdout.on('data', (b) => (stdout += b));
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(Error(`Native probe exited ${code}`));
        else {
          try {
            resolveResult(JSON.parse(stdout));
          } catch (e) {
            reject(e);
          }
        }
      });
    });
    evidence.results.node.screen = screen(evidence.results.node.samples, [
      'rss',
      'heapUsed',
      'external',
    ]);
  }
  if (mode !== 'node') {
    const server = await createServer({
      root,
      configFile: false,
      // A source edit during an hours-long probe must not reload its page.
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
      optimizeDeps: { entries: ['test/m5/browser.html'] },
      resolve: {
        alias: { '@hls-downloader/shared': resolve(root, 'packages/shared/src/index.ts') },
      },
      plugins: [
        {
          name: 'm5-wasm',
          configureServer(s) {
            s.middlewares.use((req, res, next) => {
              if (!req.url?.endsWith('hls_transmux_browser_wasm_bg.wasm')) return next();
              res.setHeader('Content-Type', 'application/wasm');
              res.end(
                readFileSync(
                  resolve(
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
    await server.listen();
    try {
      const browser = await chromium.launch({ executablePath: process.env.HLS_TEST_CHROMIUM_PATH });
      try {
        console.log(`Chrome: ${count} generated segments`);
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(server.resolvedUrls!.local[0] + 'test/m5/browser.html');
        await page.waitForFunction(() => typeof (window as any).record === 'function');
        const cdp = await page.context().newCDPSession(page);
        const samples: any[] = [];
        const started = Date.now();
        let samplingError: unknown;
        let stopped = false;
        const sampling = (async () => {
          while (!stopped) {
            const heap = await cdp.send('Runtime.getHeapUsage');
            const wasmBytes = await page.evaluate(() => (window as any).wasmBytes());
            samples.push({
              elapsedMs: Date.now() - started,
              heapUsed: heap.usedSize,
              heapTotal: heap.totalSize,
              wasmBytes,
            });
            await new Promise((r) => setTimeout(r, 1000));
          }
        })().catch((e) => (samplingError = e));
        let result;
        try {
          result = await page.evaluate(
            ({ origin, count }) => (window as any).record(origin + '/browser/master.m3u8', count),
            { origin: source.origin, count },
          );
        } finally {
          stopped = true;
          await sampling;
        }
        if (samplingError) throw samplingError;
        await cdp.send('HeapProfiler.collectGarbage');
        const before = await cdp.send('Runtime.getHeapUsage');
        await page.evaluate(
          async ({ origin, count }) => {
            for (let i = 0; i < 8; i += 2)
              await Promise.all(
                [0, 1].map((j) =>
                  (window as any).record(`${origin}/browser-cancel-${i + j}/master.m3u8`, count, 2),
                ),
              );
          },
          { origin: source.origin, count },
        );
        await cdp.send('HeapProfiler.collectGarbage');
        const after = await cdp.send('Runtime.getHeapUsage');
        if (errors.length) throw Error(errors.join('\n'));
        evidence.results.browser = {
          version: browser.version(),
          samples,
          result,
          cleanup: { before, after, concurrentCancellations: 8 },
          screen: screen(samples, ['heapUsed', 'wasmBytes']),
        };
        if (after.usedSize - before.usedSize > 16 * 1024 ** 2)
          throw Error('Browser retained heap grew across cancellation');
      } finally {
        await browser.close();
      }
    } finally {
      await server.close();
    }
  }
  evidence.passed = Object.values(evidence.results).every((r: any) =>
    Object.values(r.screen).every((s: any) => s.passed),
  );
  if (!evidence.passed) throw Error('Memory regression screen exceeded; inspect raw samples');
} catch (error) {
  evidence.passed = false;
  evidence.error = String(error);
  throw error;
} finally {
  evidence.requests = source.requests;
  mkdirSync(resolve(root, 'test-results/m5'), { recursive: true });
  const destination = resolve(root, `test-results/m5/resources-${mode}-${format}-${count}.json`);
  writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence: ${destination}`);
  await source.close();
}
