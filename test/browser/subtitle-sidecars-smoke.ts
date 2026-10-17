import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { encrypted } from '../fixtures/subtitle.ts';
const root = resolve(import.meta.dirname, '../..'),
  routes = encrypted();
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { entries: ['test/browser/subtitle-sidecars.html'] },
  resolve: { alias: { '@hls-downloader/shared': resolve(root, 'packages/shared/src/index.ts') } },
  plugins: [
    {
      name: 'subtitles',
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          const path = new URL(req.url!, 'http://local').pathname;
          if (path.endsWith('hls_transmux_browser_wasm_bg.wasm')) {
            res.setHeader('Content-Type', 'application/wasm');
            res.end(
              readFileSync(
                resolve(
                  root,
                  'packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
                ),
              ),
            );
            return;
          }
          const route = routes[path];
          if (!route) {
            next();
            return;
          }
          void route(
            { method: 'GET', path, query: new URLSearchParams(), headers: req.headers, attempt: 1 },
            res,
          );
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.HLS_TEST_CHROMIUM_PATH });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls!.local[0] + 'test/browser/subtitle-sidecars.html');
  await page.waitForFunction(() => typeof (window as any).runSubtitleSidecars === 'function');
  const results = await page.evaluate(() => (window as any).runSubtitleSidecars());
  assert.deepEqual(errors, []);
  for (const r of results.slice(0, 2)) {
    assert.equal(r.closed, true);
    assert.equal(r.ended, true);
    assert(r.frames > 0);
    assert(r.text.includes('Hello'));
    assert(r.text.includes('End'));
    assert(r.commits.some((c: any) => c.frontiers.length));
    assert.equal(r.tracks.filter((t: any) => t.kind === 'subtitle').length, r.embedded ? 1 : 0);
  }
  assert(results[2].exported.text.includes('Hello'));
  assert.equal(results[3].cancel, 'ABORTED');
  assert.equal(results[3].closed, false);
  writeFileSync(
    resolve(root, 'test-results/subtitle-sidecars-chrome.json'),
    JSON.stringify({ version: await browser.version(), results }, null, 2),
  );
  console.log(
    'Chrome: AES-128 MAP/rotation, both embedding modes, acknowledged slow Writable, actual decoded playback, finite export and blocked-sink cancellation passed',
  );
} finally {
  await browser.close();
  await server.close();
}
