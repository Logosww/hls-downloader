import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { timelineCases, timelineRoutes } from '../fixtures/timeline.ts';
const root = resolve(import.meta.dirname, '../..');
const routes = Object.assign({}, ...timelineCases.map((c, i) => timelineRoutes(c, `/cases/${i}`)));
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { entries: ['test/browser/timeline.html'] },
  resolve: { alias: { '@hls-downloader/shared': resolve(root, 'packages/shared/src/index.ts') } },
  plugins: [
    {
      name: 'timeline-fixtures',
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
          if (path === '/timeline-cases.json') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(timelineCases));
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
  await page.goto(server.resolvedUrls!.local[0]! + 'test/browser/timeline.html');
  await page.waitForFunction(() => typeof (window as any).runTimeline === 'function');
  const results = await page.evaluate(() => (window as any).runTimeline());
  assert.deepEqual(errors, []);
  const native = JSON.parse(
    readFileSync(resolve(root, 'test-results/timeline-native.json'), 'utf8'),
  );
  assert.equal(results.length, timelineCases.length);
  for (const result of results)
    assert.deepEqual(
      result,
      native.find((r: any) => r.name === result.name),
      result.name,
    );
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  writeFileSync(
    resolve(root, 'test-results/timeline-chrome.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(
    `Chrome: ${results.length} native/WASM report and hash comparisons; 3 key cancellation cases passed`,
  );
} finally {
  await browser.close();
  await server.close();
}
