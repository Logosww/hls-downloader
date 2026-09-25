import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const fixture = (name: string) => readFileSync(resolve(root, 'test/fixtures/media', name));
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  resolve: { alias: { '@hls-downloader/shared': resolve(root, 'packages/shared/src/index.ts') } },
  plugins: [
    {
      name: 'writable-fixtures',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url!, 'http://local');
          if (url.pathname.endsWith('hls_transmux_browser_wasm_bg.wasm')) {
            res.setHeader('Content-Type', 'application/wasm');
            res.end(
              readFileSync(
                resolve(
                  root,
                  'packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
                ),
              ),
            );
          } else if (url.pathname === '/fixture/media.m3u8') {
            const n = Number(url.searchParams.get('n'));
            res.end(
              '#EXTM3U\n#EXT-X-TARGETDURATION:1\n' +
                Array.from(
                  { length: n },
                  (_, i) => `#EXTINF:1,\nsegment-${i % 2}.ts?i=${i}\n`,
                ).join('') +
                '#EXT-X-ENDLIST\n',
            );
          } else if (url.pathname.startsWith('/fixture/segment-')) {
            res.end(
              fixture(
                url.pathname.endsWith('segment-0.ts') ? 'ts/segment-00.ts' : 'ts/segment-01.ts',
              ),
            );
          } else next();
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.HLS_TEST_CHROMIUM_PATH,
  args: ['--enable-precise-memory-info'],
});
const measurements = [];
try {
  for (const count of [2, 100, 1_000, 10_000]) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(server.resolvedUrls!.local[0]! + 'test/browser/writable.html');
      await page.waitForFunction(() => typeof (window as any).runWritable === 'function');
      const result = await page.evaluate(
        (count) => (window as any).runWritable(count, count === 2),
        count,
      );
      assert.equal(result.segments, count);
      assert.equal(errors.length, 0, errors.join('\n'));
      measurements.push({ count, ...result });
      console.log(JSON.stringify({ count, ...result }));
    } finally {
      await page.close();
    }
  }
  // Segment count increases 100x, while media buffers and WASM high-water stay bounded.
  // Allow allocator/GC and playlist metadata overhead rather than asserting a false constant RSS.
  assert.ok(measurements[3].wasmPeak < measurements[1].wasmPeak * 8);
  assert.ok(measurements[3].heapPeak < measurements[1].heapPeak * 8);
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  writeFileSync(
    resolve(root, 'test-results/writable-memory.json'),
    JSON.stringify(
      {
        browser: browser.version(),
        measurements,
        notes:
          'JS heap includes playlist metadata and GC slack; WASM memory is a non-shrinking high-water mark. Output is discarded for memory runs. Resource-window bounds are asserted separately in integration tests.',
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
