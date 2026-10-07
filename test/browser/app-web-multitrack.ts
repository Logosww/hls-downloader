import { chromium, type Page } from 'playwright';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { multiTrackRoutes, packedRoutes } from '../fixtures/multitrack.ts';
import { timelineCases, timelineRoutes } from '../fixtures/timeline.ts';
import type { FixtureHandler } from '../fixtures/http-server.ts';

const baseURL = process.env.HLS_APP_WEB_URL ?? 'http://localhost:3100';
const origin = 'https://app-multitrack.test';
const browser = await chromium.launch({ executablePath: process.env.HLS_TEST_CHROMIUM_PATH });
const dir = mkdtempSync(join(tmpdir(), 'app-multitrack-'));
const errors: string[] = [];
async function prepare(
  routes: Record<string, FixtureHandler>,
  source = '/master.m3u8',
  mode = 'browser',
) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(origin + '/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      handler = routes[path];
    if (path.endsWith('/key') || path.endsWith('/packed-rotated-key'))
      return route.fulfill({
        body: Buffer.from(
          path.includes('rotated')
            ? '603deb1015ca71be2b73aef0857d7781'
            : '2b7e151628aed2a6abf7158809cf4f3c',
          'hex',
        ),
      });
    if (!handler) return route.fulfill({ status: 404 });
    let body: Uint8Array | string = '',
      status = 200,
      headers: Record<string, string> = {};
    await handler({ path, method: 'GET', query: new URLSearchParams(), headers: {}, attempt: 1 }, {
      writeHead(code: number, values: Record<string, string>) {
        status = code;
        headers = values;
        return this;
      },
      end(value: Uint8Array | string) {
        body = value;
        return this;
      },
    } as any);
    await route.fulfill({
      status,
      headers: { ...headers, 'access-control-allow-origin': '*' },
      body: typeof body === 'string' ? body : Buffer.from(body),
    });
  });
  await page.addInitScript(
    ({ mode }) => {
      const state = ((window as any).multiWeb = {
        media: [] as string[],
        reports: [] as Blob[],
        files: {} as Record<string, number[]>,
        closed: [] as string[],
        removed: [] as string[],
        gestures: [] as boolean[],
        release: undefined as (() => void) | undefined,
      });
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = create(object);
        if (object instanceof Blob) {
          if (object.type === 'video/mp4') state.media.push(url);
          if (object.type === 'application/json') state.reports.push(object);
        }
        return url;
      };
      function handle(name: string) {
        return {
          name,
          isSameEntry: async () => false,
          async createWritable() {
            state.files[name] = [];
            return new WritableStream<Uint8Array>({
              write(chunk) {
                if (mode === 'write-failure' && name.includes('.002')) throw Error('test writer');
                state.files[name]!.push(...chunk);
              },
              close() {
                if (mode === 'blocked-close')
                  return new Promise<void>((resolve) => {
                    state.release = () => {
                      state.closed.push(name);
                      resolve();
                    };
                  });
                state.closed.push(name);
              },
              abort() {
                delete state.files[name];
              },
            });
          },
        };
      }
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value:
          mode === 'browser'
            ? undefined
            : async () => {
                state.gestures.push(navigator.userActivation.isActive);
                return handle('multi.mp4');
              },
      });
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value:
          mode === 'browser'
            ? undefined
            : async () => {
                state.gestures.push(navigator.userActivation.isActive);
                return {
                  isSameEntry: async () => false,
                  async getFileHandle(name: string, options?: { create?: boolean }) {
                    if (!options?.create) throw new DOMException('missing', 'NotFoundError');
                    return handle(name);
                  },
                  async removeEntry(name: string) {
                    state.removed.push(name);
                    delete state.files[name];
                  },
                };
              },
      });
    },
    { mode },
  );
  await page.goto(baseURL);
  await page.getByRole('textbox', { name: '请输入 HLS 链接' }).fill(origin + source);
  await page.getByRole('button', { name: '下载', exact: true }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('button', { name: '多轨下载', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '直接播放', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole('button', { name: 'H.264', exact: true }).isDisabled(), true);
  return page;
}
async function tracks(page: Page) {
  for (const label of ['外部音轨（多选）', '内嵌字幕（多选）']) {
    await page.getByRole('combobox', { name: label, exact: true }).click();
    await page.getByRole('option', { name: /English/ }).click();
    await page.getByRole('option', { name: /Japanese/ }).click();
    await page.keyboard.press('Escape');
  }
}
async function submit(page: Page) {
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /^(下载|选择.*下载)$/ })
    .click();
  await page
    .getByRole('alertdialog')
    .waitFor({ state: 'hidden', timeout: 10000 })
    .catch(async (e) => {
      console.error(await page.locator('body').innerText());
      console.error(errors);
      console.error(
        await page.evaluate(() => ({
          invalid: [...document.querySelectorAll(':invalid')].map((e: any) => ({
            tag: e.tagName,
            value: e.value,
            message: e.validationMessage,
          })),
          buttons: [...document.querySelectorAll('button[type=submit]')].map((e: any) => ({
            form: e.form?.id,
            disabled: e.disabled,
          })),
          values: [...document.querySelectorAll('input')].map((e: any) => ({
            name: e.name,
            value: e.value,
            type: e.type,
          })),
        })),
      );
      throw e;
    });
}
async function report(page: Page) {
  await page
    .getByRole('button', { name: '保存多轨报告', exact: true })
    .waitFor({ timeout: 10000 })
    .catch(async (error) => {
      console.error(await page.locator('body').innerText(), errors);
      throw error;
    });
  await page.getByRole('button', { name: '保存多轨报告', exact: true }).click();
  return page.evaluate(async () =>
    JSON.parse(await (window as any).multiWeb.reports.at(-1).text()),
  );
}
async function bytes(page: Page) {
  return page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await fetch((window as any).multiWeb.media.at(-1))).arrayBuffer()),
    ),
  );
}
function inspect(data: number[], name: string) {
  const file = join(dir, name + '.mp4');
  writeFileSync(file, Buffer.from(data));
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  ).streams as any[];
}
try {
  for (const embedded of ['exclude', 'keep']) {
    const page = await prepare(multiTrackRoutes());
    await tracks(page);
    if (embedded === 'exclude')
      await page.getByRole('button', { name: '排除', exact: true }).click();
    await page.getByRole('combobox', { name: '默认音轨', exact: true }).click();
    await page.getByRole('option', { name: 'Japanese', exact: true }).click();
    if (embedded === 'exclude') {
      const evidence = resolve(import.meta.dirname, '../../test-results');
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, 'app-web-multitrack-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(evidence, 'app-web-multitrack-mobile.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await submit(page);
    const r = await report(page),
      data = await bytes(page),
      streams = inspect(data, embedded);
    assert.equal(
      streams.filter((s) => s.codec_type === 'audio').length,
      embedded === 'keep' ? 3 : 2,
    );
    assert.equal(streams.filter((s) => s.codec_tag_string === 'wvtt').length, 2);
    assert.ok(Buffer.from(data).includes(Buffer.from('こんにちは')));
    assert.equal(
      r.tracks.find((t: any) => t.kind === 'audio' && t.metadata.default).metadata.name,
      'Japanese',
    );
    assert.equal(r.tracks.length, embedded === 'keep' ? 6 : 5);
    await page.close();
    console.log('PASS app multi audio/text metadata, default track and embedded ' + embedded);
  }
  const variants = multiTrackRoutes();
  variants['/master.m3u8'] = (_, res) =>
    res.end(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="en/media.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="ja",URI="ja/media.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="cc-en/media.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Japanese",URI="cc-ja/media.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="b",NAME="Other",URI="en/media.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=128x72,AUDIO="a",SUBTITLES="s"\nvideo/media.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180,AUDIO="b"\nvideo/media.m3u8\n',
    );
  const switched = await prepare(variants);
  await tracks(switched);
  await switched.getByRole('combobox', { name: '视频质量', exact: true }).click();
  await switched.getByRole('option', { name: '320x180', exact: true }).click();
  assert.equal(
    await switched.getByRole('combobox', { name: '内嵌字幕（多选）', exact: true }).isDisabled(),
    true,
  );
  await switched.getByRole('combobox', { name: '外部音轨（多选）', exact: true }).click();
  await switched.getByRole('option', { name: 'Other', exact: true }).waitFor();
  assert.equal(await switched.getByRole('option').count(), 1);
  await switched.getByRole('option', { name: 'Other', exact: true }).click();
  await switched.keyboard.press('Escape');
  await submit(switched);
  const switchedReport = await report(switched);
  assert.equal(switchedReport.tracks.filter((t: any) => t.kind === 'audio').length, 2);
  assert.equal(
    switchedReport.tracks.some((t: any) => t.kind === 'subtitle'),
    false,
  );
  await switched.close();
  console.log('PASS variant changes clear selections and constrain associated groups');
  for (const kind of ['clear', 'aes128', 'sample_aes', 'aes128_rotation', 'sample_aes_rotation']) {
    const page = await prepare(packedRoutes(kind), '/input.m3u8');
    await submit(page);
    const r = await report(page);
    assert.equal(r.tracks[0].sampleCount, '53');
    assert.equal(r.tracks[0].timescale, 44100);
    assert.equal(inspect(await bytes(page), kind)[0].codec_name, 'aac');
    await page.close();
    console.log('PASS app Packed AAC ' + kind);
  }
  for (const [options, message] of [
    [{ open: true }, '所有所选播放列表均已结束'],
    [{ subtitle: 'WEBVTT\n\n00:00.000 --> 00:01.000\n<b>invalid</b>\n' }, '多轨'],
  ] as const) {
    const page = await prepare(multiTrackRoutes('', options));
    await tracks(page);
    await submit(page);
    await page.getByText(message, { exact: false }).first().waitFor();
    await page.waitForFunction(() => document.body.innerText.includes('失败'));
    assert.equal(await page.getByRole('button', { name: '保存多轨报告', exact: true }).count(), 0);
    await page.close();
    console.log('PASS app rejects unfinished / unsupported subtitle input');
  }
  const filePage = await prepare(multiTrackRoutes(), '/master.m3u8', 'file');
  await tracks(filePage);
  await submit(filePage);
  await report(filePage);
  assert.deepEqual(await filePage.evaluate(() => (window as any).multiWeb.gestures), [true]);
  assert.deepEqual(await filePage.evaluate(() => (window as any).multiWeb.closed), ['multi.mp4']);
  inspect(await filePage.evaluate(() => (window as any).multiWeb.files['multi.mp4']), 'direct');
  await filePage.close();
  console.log('PASS file picker gesture, actual output and close before completion');

  const c = timelineCases.find((c) => c.name === 'config-split');
  for (const mode of ['browser', 'write-failure']) {
    const page = await prepare(timelineRoutes(c), '/master.m3u8', mode);
    await page.getByRole('button', { name: '时间轴下载', exact: true }).click();
    await page.getByRole('combobox', { name: '配置变化', exact: true }).click();
    await page.getByRole('option', { name: '拆分独立文件', exact: true }).click();
    await submit(page);
    if (mode === 'browser') {
      const r = await report(page);
      assert.equal(r.outputs.length, 2);
      assert.equal(await page.getByRole('button', { name: '保存文件', exact: true }).count(), 2);
    } else {
      await page.waitForFunction(() => document.body.innerText.includes('失败'));
      assert.deepEqual(await page.evaluate(() => (window as any).multiWeb.closed), [
        'output.001.mp4',
      ]);
      assert.equal(await page.getByRole('button', { name: '已保存', exact: true }).count(), 1);
    }
    await page.close();
    console.log('PASS app split outputs / preserves closed file after failure ' + mode);
  }
  const blocked = await prepare(multiTrackRoutes(), '/master.m3u8', 'blocked-close');
  await tracks(blocked);
  await submit(blocked);
  await blocked.waitForFunction(() => typeof (window as any).multiWeb.release === 'function');
  assert.equal(await blocked.getByRole('button', { name: '保存多轨报告', exact: true }).count(), 0);
  await blocked.getByRole('button', { name: /^取消 / }).click();
  await blocked.waitForFunction(() => document.body.innerText.includes('已取消'));
  await blocked.evaluate(() => (window as any).multiWeb.release());
  assert.equal(await blocked.getByRole('button', { name: '保存多轨报告', exact: true }).count(), 0);
  await blocked.close();
  console.log('PASS app cancellation during sink close');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
