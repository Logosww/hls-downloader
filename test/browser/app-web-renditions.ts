import { chromium } from 'playwright';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const origin = 'https://app-rendition.test';
const baseURL = process.env.HLS_APP_WEB_URL ?? 'http://localhost:3100';
const browser = await chromium.launch({ executablePath: process.env.HLS_TEST_CHROMIUM_PATH });
const dir = mkdtempSync(join(tmpdir(), 'app-renditions-'));
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const paths: string[] = [];
  await page.route(origin + '/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    const master =
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="audio/media.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90,AUDIO="a"\nvideo/media.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,AUDIO="a"\nhigh/media.m3u8\n';
    await route.fulfill({
      body:
        path === '/master.m3u8'
          ? master
          : readFileSync(
              resolve(
                root,
                'test/fixtures/media',
                path.startsWith('/audio/') ? 'audio-ts' : 'ts',
                path.split('/').at(-1)!,
              ),
            ),
      headers: {
        'access-control-allow-origin': '*',
        'content-type': path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      },
    });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    const create = URL.createObjectURL.bind(URL);
    (window as any).outputs = [];
    URL.createObjectURL = (object) => {
      const url = create(object);
      if (object instanceof Blob && object.type === 'video/mp4') (window as any).outputs.push(url);
      return url;
    };
  });
  const select = async () => {
    await page.goto(baseURL);
    await page.getByRole('textbox', { name: '请输入 HLS 链接' }).fill(origin + '/master.m3u8');
    await page.getByRole('button', { name: '下载', exact: true }).click();
    await page.getByRole('alertdialog').waitFor();
  };
  await select();
  await page.getByRole('alertdialog').getByRole('button', { name: '下载', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).waitFor();
  const bytes = await page.evaluate(async () =>
    Array.from(new Uint8Array(await (await fetch((window as any).outputs[0])).arrayBuffer())),
  );
  const file = join(dir, 'selected.mp4');
  writeFileSync(file, Buffer.from(bytes));
  const pcm = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-f',
    'f32le',
    '-ac',
    '1',
    '-ar',
    '48000',
    'pipe:1',
  ]);
  const samples = new Float32Array(
    pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
  );
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1]! <= 0 && samples[i]! > 0) crossings++;
  assert.ok(crossings / (samples.length / 48000) > 800, 'must contain external 880 Hz audio');
  assert.ok(paths.includes('/audio/media.m3u8'));
  assert.equal(
    paths.some((path) => path.startsWith('/high/')),
    false,
    'must keep the chosen lower quality',
  );
  console.log(
    'PASS Web download retains master audio and selected variant; decoded audio is 880 Hz',
  );

  await select();
  assert.equal(
    await page.evaluate(() =>
      MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
    ),
    true,
  );
  await page.getByRole('button', { name: '直接播放', exact: true }).click();
  await page.locator('video').waitFor({ state: 'attached' });
  await page
    .waitForFunction(() => {
      const video = document.querySelector('video');
      return video && video.readyState >= 2 && video.duration > 1;
    })
    .catch(async (error) => {
      console.error(
        await page.evaluate(() => ({
          text: document.body.innerText,
          video: (() => {
            const v = document.querySelector('video');
            return v
              ? {
                  src: v.src,
                  ready: v.readyState,
                  network: v.networkState,
                  error: v.error?.message,
                  duration: v.duration,
                }
              : null;
          })(),
        })),
      );
      console.error(paths, errors);
      throw error;
    });
  assert.equal(await page.locator('video').evaluate((v: HTMLVideoElement) => v.error), null);
  const duration = await page.locator('video').evaluate((v: HTMLVideoElement) => v.duration);
  assert.ok(duration < 3);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS Web preview awaits MSE append completion and plays dual-input output');
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
