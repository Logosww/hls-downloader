import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../..');
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { entries: ['test/browser/renditions.html'] },
  resolve: { alias: { '@hls-downloader/shared': resolve(root, 'packages/shared/src/index.ts') } },
  plugins: [
    {
      name: 'rendition-fixtures',
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
          } else if (path === '/fixture/master.m3u8')
            res.end(
              '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio-ts/media.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="en",URI="subs.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90,AUDIO="a",SUBTITLES="s"\nts/media.m3u8\n',
            );
          else if (path === '/fixture/subs.m3u8')
            res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsubs.vtt\n#EXT-X-ENDLIST\n');
          else if (path === '/fixture/subs.vtt')
            res.end(
              'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n\n00:00:00.500 --> 00:00:01.000\nHello\n',
            );
          else if (/^\/fixture\/(ts|audio-ts)\/[a-zA-Z0-9.-]+$/.test(path))
            res.end(
              readFileSync(resolve(root, 'test/fixtures/media', path.slice('/fixture/'.length))),
            );
          else next();
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
  await page.goto(server.resolvedUrls!.local[0]! + 'test/browser/renditions.html');
  await page.waitForFunction(() => typeof (window as any).runRenditions === 'function');
  const results = await page.evaluate(() => (window as any).runRenditions());
  assert.equal(results.length, 3);
  assert.equal(errors.length, 0, errors.join('\n'));
  for (const result of results) {
    assert.ok(result.bytes > 1000);
    assert.ok(result.duration > 1.9 && result.duration < 2.2);
  }
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  await server.close();
}
