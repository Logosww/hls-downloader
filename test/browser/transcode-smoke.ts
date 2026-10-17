import { createServer } from 'vite';
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { timelineCases, timelineRoutes } from '../fixtures/timeline.ts';
const root = resolve(import.meta.dirname, '../..');
const routes = Object.assign(
  {},
  ...timelineCases.map((c) => timelineRoutes(c, `/cases/${c.name}`)),
);
const server = await createServer({
  root,
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { entries: ['test/browser/transcode.html'] },
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
const directory = mkdtempSync(join(tmpdir(), 'hls-browser-transcode-'));
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls!.local[0] + 'test/browser/transcode.html');
  await page.waitForFunction(() => typeof (window as any).runTranscode === 'function');
  assert.deepEqual(await page.evaluate(() => (window as any).runUnsupportedEncoder()), {
    code: 'UNSUPPORTED_OUTPUT',
    reason: 'UnsupportedEncoder',
  });
  await page.reload();
  await page.waitForFunction(() => typeof (window as any).runTranscode === 'function');
  const results = await page.evaluate(() => (window as any).runTranscode());
  assert.deepEqual(errors, []);
  assert(results.some((r: any) => r.preset === 'vp9' && !r.unsupported));
  for (const [i, r] of results.entries()) {
    if (r.unsupported) continue;
    const path = join(directory, i + (r.preset === 'vp9' ? '.webm' : '.mp4'));
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
        { encoding: 'utf8' },
      ),
    );
    assert.deepEqual(
      probe.streams.map((s: any) => s.codec_name),
      r.name === 'sample-fmp4_hevc_cbcs'
        ? ['vp9']
        : r.preset === 'vp9'
          ? ['vp9', 'opus']
          : [r.preset === 'h264' ? 'h264' : 'hevc', 'aac'],
      r.name ?? r.preset,
    );
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-']);
    r.duration = Number(probe.format.duration);
    const expectedDuration = r.name === 'sample-fmp4_hevc_cbcs' ? 6 : 4;
    assert(Math.abs(r.duration - expectedDuration) < 0.1, 'Decodable range duration');
    r.playback = await page.evaluate(
      async ({ data, mime }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const video = document.createElement('video');
        video.muted = true;
        video.controls = true;
        document.body.append(video);
        let timer: ReturnType<typeof setTimeout>;
        try {
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Playback timed out')), 15000);
            video.onerror = () => reject(new Error('Playback error ' + video.error?.code));
            video.onended = () => resolve();
            video.src = url;
            void video.play().catch(reject);
          });
          return {
            ended: video.ended,
            duration: video.duration,
            frames: video.getVideoPlaybackQuality().totalVideoFrames,
          };
        } finally {
          clearTimeout(timer!);
          video.pause();
          video.removeAttribute('src');
          video.load();
          video.remove();
          URL.revokeObjectURL(url);
        }
      },
      { data: r.data, mime: r.preset === 'vp9' ? 'video/webm' : 'video/mp4' },
    );
    assert(r.playback.ended && r.playback.frames > 0, 'Chrome actually played frames');
    r.starts = probe.streams.map((s: any) => Number(s.start_time));
    if (r.starts.length === 2)
      assert(
        Math.abs(r.starts[1] - r.starts[0]) < 0.03,
        'Audio/video offset preserved within encoder priming',
      );
    delete r.data;
  }
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  writeFileSync(
    resolve(root, 'test-results/transcode-chrome.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(
    'Chrome selected transcode, bounded output and cancellation:',
    JSON.stringify(results),
  );
} finally {
  await browser.close();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
}
