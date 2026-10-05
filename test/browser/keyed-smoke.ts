import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { encryptedRoutes } from '../fixtures/encrypted.ts';
const root = resolve(import.meta.dirname, '../..');
const fixtures = {
  ts: encryptedRoutes('ts', true, true, process.env.HLS_KEYED_UNALIGNED !== '1'),
  fmp4: encryptedRoutes('fmp4', true, true, process.env.HLS_KEYED_UNALIGNED !== '1'),
};
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { entries: ['test/browser/keyed.html'] },
  resolve: { alias: { '@hls-downloader/shared': resolve(root, 'packages/shared/src/index.ts') } },
  plugins: [
    {
      name: 'keyed-fixtures',
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
          if (path === '/key') {
            void fixtures.ts['/key']!(
              {
                method: 'GET',
                path,
                query: new URLSearchParams(),
                headers: req.headers,
                attempt: 1,
              },
              res,
            );
            return;
          }
          const match = path.match(/^\/(ts|fmp4)(\/.*)$/);
          const handler = match && fixtures[match[1] as keyof typeof fixtures][match[2]!];
          if (!handler) {
            next();
            return;
          }
          void handler(
            {
              method: 'GET',
              path: match![2]!,
              query: new URLSearchParams(),
              headers: req.headers,
              attempt: 1,
            },
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
  await page.goto(server.resolvedUrls!.local[0]! + 'test/browser/keyed.html');
  await page.waitForFunction(() => typeof (window as any).runKeyed === 'function');
  const results = await page.evaluate(() => (window as any).runKeyed());
  assert.equal(results.length, 6);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results));
  for (const result of results) {
    assert.ok(result.bytes > 1000);
    const expected = process.env.HLS_KEYED_UNALIGNED === '1' ? 3.4 : 2;
    assert.ok(
      Math.abs(result.duration - expected) < 0.2,
      `${result.format}/${result.mode}: unexpected duration ${result.duration}`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
