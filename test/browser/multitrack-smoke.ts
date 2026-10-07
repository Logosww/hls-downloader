import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { multiTrackRoutes, packedRoutes } from '../fixtures/multitrack.ts';
const root = resolve(import.meta.dirname, '../..');
const routes = Object.assign(
  multiTrackRoutes(),
  ...['clear', 'aes128', 'sample_aes', 'aes128_rotation', 'sample_aes_rotation'].map((k) =>
    packedRoutes(k, '/packed/' + k),
  ),
);
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { entries: ['test/browser/multitrack.html'] },
  resolve: { alias: { '@hls-downloader/shared': resolve(root, 'packages/shared/src/index.ts') } },
  plugins: [
    {
      name: 'multitrack-fixtures',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
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
          const handler = routes[path];
          if (!handler) {
            next();
            return;
          }
          void handler(
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
  const page = await browser.newPage(),
    errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls!.local[0]! + 'test/browser/multitrack.html');
  await page.waitForFunction(() => typeof (window as any).runMultiTrack === 'function');
  const results = await page.evaluate(() => (window as any).runMultiTrack());
  assert.deepEqual(errors, []);
  assert.deepEqual(
    results,
    JSON.parse(readFileSync(resolve(root, 'test-results/multitrack-native.json'), 'utf8')),
  );
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  writeFileSync(
    resolve(root, 'test-results/multitrack-chrome.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(
    'Chrome: Native/WASM multi-track hash/report parity, 5 Packed AAC profiles and blocked-writer cancellation passed',
  );
} finally {
  await browser.close();
  await server.close();
}
