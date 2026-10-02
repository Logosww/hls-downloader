import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const appRequire = createRequire(resolve(root, 'packages/app/web/package.json'));
const server = await createServer({
  root,
  configFile: false,
  optimizeDeps: { entries: ['test/browser/metadata-cancellation.html'] },
  resolve: {
    alias: [
      { find: /^react$/, replacement: appRequire.resolve('react') },
      { find: /^react-dom\/client$/, replacement: appRequire.resolve('react-dom/client') },
      {
        find: '@hls-downloader/shared',
        replacement: resolve(root, 'packages/shared/src/index.ts'),
      },
    ],
  },
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.HLS_TEST_CHROMIUM_PATH });
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n';
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const reset = async () => {
    await page.goto(server.resolvedUrls!.local[0]! + 'test/browser/metadata-cancellation.html');
    await page.waitForFunction(() => typeof (window as any).resolveMetadata === 'function');
  };
  const start = async (name: string, path: string) =>
    page.evaluate(({ name, path }) => (window as any).start(name, path), { name, path });
  const requests = async (n: number) =>
    page.waitForFunction((n) => (window as any).requests.length === n, n);
  const reply = async (index: number, body: string, status = 200) =>
    page.evaluate(({ index, body, status }) => (window as any).reply(index, body, status), {
      index,
      body,
      status,
    });

  await reset();
  await start('old', 'old.m3u8');
  await requests(1);
  await start('newest', 'new.m3u8');
  await requests(2);
  await page.waitForFunction(() => (window as any).old === null);
  assert.equal(await page.evaluate(() => (window as any).requests[0].aborted), true);
  // A late old response must not start a poster or replace the new operation.
  await reply(0, playlist);
  await reply(1, playlist);
  await requests(3);
  await reply(2, playlist);
  await requests(4);
  await reply(3, '', 403);
  await page.waitForFunction(() => (window as any).newest === true);
  assert.equal(await page.locator('output').textContent(), 'https://metadata.test/new.m3u8');
  console.log(
    'PASS superseded parsing is aborted; late results ignored; optional poster failure still succeeds',
  );

  await reset();
  await start('first', 'first.m3u8');
  await requests(1);
  await start('second', 'second.m3u8');
  await requests(2);
  await page.waitForFunction(() => (window as any).first === null);
  await page.evaluate(() => (window as any).unmount());
  await page.waitForFunction(() => (window as any).second === null);
  assert.equal(await page.evaluate(() => (window as any).requests[1].aborted), true);
  console.log('PASS unmount aborts the newer parse after the older operation finishes');

  await reset();
  await start('poster', 'poster.m3u8');
  await requests(1);
  await reply(0, playlist);
  await requests(2);
  await reply(1, playlist);
  await requests(3);
  await start('replacement', 'replacement.m3u8');
  await requests(4);
  await page.waitForFunction(() => (window as any).poster === null);
  assert.equal(await page.evaluate(() => (window as any).requests[2].aborted), true);
  await reply(3, playlist);
  await requests(5);
  await reply(4, playlist);
  await requests(6);
  await page.evaluate(() => (window as any).unmount());
  await page.waitForFunction(() => (window as any).replacement === null);
  assert.equal(await page.evaluate(() => (window as any).requests[5].aborted), true);
  console.log('PASS replacement and unmount both abort active poster reads');

  await reset();
  await start('invalid', 'invalid.m3u8');
  await requests(1);
  await reply(0, '', 403);
  await page.waitForFunction(() => (window as any).invalid === false);
  console.log('PASS real manifest failure remains distinguishable from cancellation');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
