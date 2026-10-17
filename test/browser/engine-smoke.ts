import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createCipheriv } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../..'),
  routes = new Map<string, Buffer>();
const key = Buffer.alloc(32, 7),
  iv = Buffer.alloc(16, 3);
for (const [kind, folder] of [
  ['ts', 'media/ts'],
  ['fmp4', 'media/fmp4'],
  ['packed', 'packed-aac/clear'],
] as const) {
  const directory = resolve(root, 'test/fixtures', folder);
  for (const file of readdirSync(directory)) {
    const data = readFileSync(join(directory, file));
    if (file.endsWith('.m3u8'))
      routes.set(
        `/gcm/${kind}/media.m3u8`,
        Buffer.from(
          data.toString().replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-256-GCM,URI="key"'),
        ),
      );
    else {
      const c = createCipheriv('aes-256-gcm', key, iv);
      routes.set(
        `/gcm/${kind}/${file}`,
        Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]),
      );
    }
  }
  routes.set(`/gcm/${kind}/key`, key);
}
for (const [path, data] of [...routes])
  if (path.startsWith('/gcm/ts/')) {
    const changed = Buffer.from(data);
    if (path.endsWith('.ts')) changed[changed.length - 1] ^= 1;
    routes.set(path.replace('/gcm/ts/', '/tampered/'), changed);
  }
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { entries: ['test/browser/engine.html'] },
  resolve: { alias: { '@hls-downloader/shared': resolve(root, 'packages/shared/src/index.ts') } },
  plugins: [
    {
      name: 'engine-fixtures',
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
          const data = routes.get(path);
          if (!data) {
            next();
            return;
          }
          res.end(data);
        });
      },
    },
  ],
});
await server.listen();
const dir = mkdtempSync(join(tmpdir(), 'hls-browser-engine-'));
const browser = await chromium.launch({ executablePath: process.env.HLS_TEST_CHROMIUM_PATH });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls!.local[0] + 'test/browser/engine.html');
  await page.waitForFunction(() => typeof (window as any).runEngine === 'function');
  const results = await page.evaluate(() => (window as any).runEngine());
  assert.deepEqual(errors, []);
  for (const r of results) {
    const file = join(dir, r.kind + '.mp4');
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], {
      stdio: 'pipe',
    });
  }
  console.log(
    'Chrome Engine: TS/fMP4/Packed AAC GCM decode, default rejection, key length, tampered authentication and collection budget passed',
  );
} finally {
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
