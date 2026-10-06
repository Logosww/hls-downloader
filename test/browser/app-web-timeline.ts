import { chromium, type Locator, type Page } from 'playwright';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { timelineCases, timelineRoutes, sampleKey } from '../fixtures/timeline.ts';
const root = resolve(import.meta.dirname, '../..');
const baseURL = process.env.HLS_APP_WEB_URL ?? 'http://localhost:3100';
const origin = 'https://app-timeline.test';
const browser = await chromium.launch({ executablePath: process.env.HLS_TEST_CHROMIUM_PATH });
const dir = mkdtempSync(join(tmpdir(), 'app-web-timeline-'));
const errors: string[] = [],
  results: string[] = [];
function verify(bytes: number[], name: string) {
  const file = join(dir, name + '.mp4');
  writeFileSync(file, Buffer.from(bytes));
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  );
  assert.ok(Number(probe.format.duration) > 0);
}
async function prepare(name: string, mode = 'browser') {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const routes = timelineRoutes(
    timelineCases.find(
      (item) =>
        item.name ===
        (name === 'subtitle-ambiguous'
          ? 'clock-reset'
          : name === 'subtitle-valid'
            ? 'range-False'
            : name),
    ),
  );
  if (name.startsWith('subtitle')) {
    const master = routes['/master.m3u8']!;
    routes['/master.m3u8'] = async (request, response) => {
      let text = '';
      await master(request, {
        writeHead() {
          return this;
        },
        end(value: string) {
          text = value;
        },
      } as any);
      response.end(
        text
          .replace(
            '#EXTM3U\n',
            '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="sub.m3u8"\n',
          )
          .replace('BANDWIDTH=100000', 'BANDWIDTH=100000,SUBTITLES="s"'),
      );
    };
    routes['/sub.m3u8'] = (_, response) => {
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsub.vtt\n#EXT-X-ENDLIST\n');
    };
    routes['/sub.vtt'] = (_, response) => {
      response.end(
        'WEBVTT\n' +
          'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:132000\n' +
          '\n00:00:00.500 --> 00:00:02.000\nAligned cue\n',
      );
    };
  }
  await page.route(origin + '/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/key')) return route.fulfill({ body: Buffer.from(sampleKey) });
    const handler = routes[path];
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
      const state = ((window as any).timelineTest = {
        mode,
        gestures: [] as boolean[],
        opened: [] as string[],
        closed: [] as string[],
        media: [] as string[],
        reports: [] as Blob[],
        sidecars: [] as Blob[],
        release: undefined as undefined | (() => void),
      });
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        const url = create(object);
        if (object instanceof Blob) {
          if (object.type === 'video/mp4') state.media.push(url);
          if (object.type === 'application/json') state.reports.push(object);
          if (object.type === 'text/vtt') state.sidecars.push(object);
        }
        return url;
      };
      const wrap = (handle: FileSystemFileHandle) => ({
        name: handle.name,
        isSameEntry: async () => false,
        async createWritable() {
          state.opened.push(handle.name);
          const writable = await handle.createWritable();
          let first = true;
          return new WritableStream<Uint8Array>({
            async write(bytes) {
              if (state.mode === 'write-failure' && handle.name.includes('.002'))
                throw new Error('test sink write');
              if (state.mode === 'blocked' && handle.name.includes('.002') && first) {
                first = false;
                await new Promise<void>((resolve) => {
                  state.release = resolve;
                });
              }
              await writable.write(bytes);
            },
            async close() {
              if (state.mode === 'close-failure' && handle.name.includes('.002')) {
                await writable.abort();
                throw new Error('test sink close');
              }
              await writable.close();
              state.closed.push(handle.name);
            },
            async abort(reason) {
              await writable.abort(reason).catch(() => {});
            },
          });
        },
      });
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value:
          mode === 'browser'
            ? undefined
            : async () => {
                state.gestures.push(navigator.userActivation.isActive);
                return wrap(
                  await (
                    await navigator.storage.getDirectory()
                  ).getFileHandle('timeline-single.mp4', { create: true }),
                );
              },
      });
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value:
          mode === 'browser'
            ? undefined
            : async () => {
                state.gestures.push(navigator.userActivation.isActive);
                const directory = await navigator.storage.getDirectory();
                return {
                  name: 'timeline-output',
                  isSameEntry: async () => false,
                  getFileHandle: async (name: string, options?: FileSystemGetFileOptions) => {
                    const handle = await directory.getFileHandle(name, options);
                    if (state.mode === 'late-factory' && name.includes('.002') && options?.create)
                      await new Promise<void>((resolve) => {
                        state.release = resolve;
                      });
                    return wrap(handle);
                  },
                  removeEntry: (name: string) => directory.removeEntry(name),
                };
              },
      });
    },
    { mode },
  );
  await page.goto(baseURL);
  await page.getByRole('textbox', { name: '请输入 HLS 链接' }).fill(origin + '/master.m3u8');
  await page.getByRole('button', { name: '下载', exact: true }).click();
  await page.getByRole('alertdialog').waitFor();
  return page;
}
async function timeline(page: Page, split = false) {
  await page.getByRole('button', { name: '时间轴下载', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '直接播放', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole('button', { name: 'H.264', exact: true }).isDisabled(), true);
  if (split) {
    await page.getByRole('combobox', { name: '配置变化' }).click();
    await page.getByRole('option', { name: '拆分独立文件' }).click();
  }
}
async function submit(page: Page) {
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /^(下载|选择位置并下载|选择文件夹并下载)$/ })
    .click();
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
}
async function report(page: Page) {
  await page.getByRole('button', { name: '保存时间轴报告' }).click();
  return page.evaluate(async () =>
    JSON.parse(await (window as any).timelineTest.reports.at(-1).text()),
  );
}
async function mediaBytes(page: Page) {
  return page.evaluate(async () =>
    Array.from(
      new Uint8Array(await (await fetch((window as any).timelineTest.media.at(-1))).arrayBuffer()),
    ),
  );
}
async function fileBytes(page: Page, name: string) {
  return page.evaluate(
    async (name) =>
      Array.from(
        new Uint8Array(
          await (
            await (await navigator.storage.getDirectory()).getFileHandle(name)
          )
            .getFile()
            .then((file) => file.arrayBuffer()),
        ),
      ),
    name,
  );
}
async function settleAnimations(locator: Locator) {
  await locator.evaluate(async (element) => {
    // Base UI applies starting styles on mount and removes them on the next frame.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}
async function verifyConfirmLayout(width: number, height: number) {
  const page = await prepare('subtitle-valid');
  await page.setViewportSize({ width, height });
  const dialog = page.getByRole('alertdialog');
  await settleAnimations(dialog);
  const legacy = (await dialog.boundingBox())!;
  await timeline(page);
  const bounds = (await dialog.boundingBox())!;
  assert.ok(bounds.height <= Math.min(640, height - 32));
  assert.ok(bounds.height <= legacy.height + 16, 'height stays near the full-download form');
  assert.ok(bounds.y >= 16 && bounds.y + bounds.height <= height - 16);
  const header = dialog.locator('[data-slot="alert-dialog-header"]');
  const footer = dialog.locator('[data-slot="alert-dialog-footer"]');
  const viewport = dialog.locator('[data-slot="scroll-area-viewport"]');
  const headerBounds = (await header.boundingBox())!;
  const footerBounds = (await footer.boundingBox())!;
  assert.ok(headerBounds.y >= bounds.y);
  assert.ok(footerBounds.y + footerBounds.height <= bounds.y + bounds.height);
  assert.equal(
    await viewport.evaluate((element) => element.scrollHeight > element.clientHeight),
    true,
  );
  assert.equal(await dialog.evaluate((element) => getComputedStyle(element).overflowY), 'hidden');

  for (const name of ['缺口处理', '配置变化', 'WebVTT 字幕']) {
    const trigger = page.getByRole('combobox', { name });
    await trigger.click();
    const popup = page.locator('[data-slot="select-content"][data-open]');
    await popup.waitFor({ state: 'visible' });
    await settleAnimations(popup);
    const triggerBounds = (await trigger.boundingBox())!;
    const popupBounds = (await popup.boundingBox())!;
    assert.ok(Math.abs(popupBounds.x - triggerBounds.x) <= 1, `${name}: left alignment`);
    assert.ok(Math.abs(popupBounds.width - triggerBounds.width) <= 1, `${name}: matching width`);
    assert.ok(popupBounds.y + popupBounds.height <= height, `${name}: within viewport`);
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'hidden' });
  }

  const advanced = page.getByRole('button', { name: '高级时间轴设置', exact: true });
  assert.equal(await advanced.getAttribute('aria-expanded'), 'false');
  await advanced.focus();
  await advanced.press('Enter');
  assert.equal(await advanced.getAttribute('aria-expanded'), 'true');
  const input = page.getByRole('textbox', { name: '锚点、预算与尾帧时长（JSON）' });
  await input.fill('{}');
  // Also cover user-resized textareas rather than just the initial form length.
  await input.evaluate((element) => {
    element.style.height = '800px';
  });
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  assert.deepEqual(await header.boundingBox(), headerBounds);
  assert.deepEqual(await footer.boundingBox(), footerBounds);
  assert.equal(await viewport.evaluate((element) => element.scrollTop > 0), true);
  await advanced.press('Space');
  assert.equal(await advanced.getAttribute('aria-expanded'), 'false');
  await advanced.press('Enter');
  assert.equal(await input.inputValue(), '{}');
  assert.equal(await dialog.count(), 1, 'accordion activation never submits the form');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  results.push(`confirm modal layout ${width}x${height}, select alignment, keyboard accordion`);
  await page.close();
}
try {
  await verifyConfirmLayout(1280, 900);
  await verifyConfirmLayout(390, 720);
  await verifyConfirmLayout(844, 390);
  {
    const page = await prepare('range-False');
    await timeline(page);
    await page.getByRole('textbox', { name: '开始时间（秒）' }).fill('0.2');
    await page.getByRole('textbox', { name: '结束时间（秒，不含）' }).fill('0.2');
    await page.getByRole('alertdialog').getByRole('button', { name: '下载', exact: true }).click();
    await page.getByText('结束时间必须大于开始时间', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '结束时间（秒，不含）' }).fill('4.2');
    await page.getByRole('textbox', { name: '章节（可选）' }).fill('0.2 --> 4.2 | Example chapter');
    await submit(page);
    await page.getByRole('button', { name: '保存文件', exact: true }).waitFor();
    const value = await report(page);
    assert.deepEqual(value.requested, {
      start: { ticks: '2', timescale: 10 },
      end: { ticks: '42', timescale: 10 },
    });
    assert.ok(value.preroll && value.postroll);
    verify(await mediaBytes(page), 'range');
    await page.getByRole('button', { name: '保存 WebVTT' }).click();
    assert.match(
      await page.evaluate(() => (window as any).timelineTest.sidecars.at(-1).text()),
      /Example chapter/,
    );
    await page.getByRole('button', { name: '保存文件', exact: true }).click();
    await page.getByRole('button', { name: '已保存', exact: true }).first().waitFor();
    results.push('range, exact inputs, report, chapters, save');
    await page.close();
  }
  {
    const page = await prepare('config-split');
    await timeline(page, true);
    await submit(page);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('button')].filter(
          (button) => button.textContent === '保存文件',
        ).length === 2,
    );
    const value = await report(page);
    assert.equal(value.outputs.length, 2);
    assert.equal(value.outputs[1].reason, 'ConfigurationChanged');
    const media = await page.evaluate(async () =>
      Promise.all(
        (window as any).timelineTest.media.map(async (url: string) =>
          Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())),
        ),
      ),
    );
    media.forEach((bytes: number[], index: number) => verify(bytes, 'split-' + index));
    await page.getByRole('button', { name: '保存文件' }).first().click();
    assert.equal(await page.getByRole('button', { name: '保存文件' }).count(), 1);
    results.push('classic MP4 split and independent save');
    await page.close();
  }
  for (const mode of ['file', 'write-failure', 'close-failure', 'blocked']) {
    const page = await prepare('config-split', mode);
    await timeline(page, true);
    await submit(page);
    if (mode === 'blocked') {
      await page.waitForFunction(() => typeof (window as any).timelineTest.release === 'function');
      await page.getByRole('button', { name: /^取消 .*\.mp4$/ }).click();
      await page.evaluate(() => (window as any).timelineTest.release());
      await page.getByText('大文件直存 · 已取消').waitFor();
    } else if (mode === 'close-failure' || mode === 'write-failure')
      await page.getByText('文件写入失败', { exact: false }).first().waitFor();
    else await page.getByRole('button', { name: '保存时间轴报告' }).waitFor();
    const state = await page.evaluate(() => {
      const { gestures, closed } = (window as any).timelineTest;
      return { gestures, closed };
    });
    assert.deepEqual(state.gestures, [true]);
    assert.equal(state.closed.length, mode === 'file' ? 2 : 1);
    assert.equal(
      await page.getByRole('button', { name: '已保存', exact: true }).count(),
      mode === 'file' ? 3 : 1,
    );
    for (const name of state.closed) verify(await fileBytes(page, name), mode + '-' + name);
    results.push('directory output ' + mode);
    await page.close();
  }
  {
    const page = await prepare('config-split', 'late-factory');
    await timeline(page, true);
    await submit(page);
    await page.waitForFunction(() => typeof (window as any).timelineTest.release === 'function');
    await page.getByRole('button', { name: /^取消 .*\.mp4$/ }).click();
    await page.getByText('大文件直存 · 已取消').waitFor();
    await page.evaluate(() => (window as any).timelineTest.release());
    await page.waitForFunction(async () => {
      const directory = await navigator.storage.getDirectory();
      const names: string[] = [];
      for await (const name of (directory as any).keys()) names.push(name);
      return names.length === 0;
    });
    assert.deepEqual(await page.evaluate(() => (window as any).timelineTest.closed), []);
    results.push('late directory Promise cleanup');
    await page.close();
  }
  {
    const page = await prepare('range-False', 'file');
    await timeline(page);
    await page.getByRole('button', { name: '高级时间轴设置', exact: true }).click();
    await page
      .getByRole('textbox', { name: '锚点、预算与尾帧时长（JSON）' })
      .fill('{"limits":{"samples":1}}');
    await submit(page);
    await page.getByText('时间轴规划超出预算', { exact: false }).first().waitFor();
    assert.deepEqual(await page.evaluate(() => (window as any).timelineTest.opened), []);
    results.push('planning budget before writer acquisition');
    await page.close();
  }
  for (const [name, explicit] of [
    ['sample-fmp4_avc_cenc', false],
    ['sample-ts_avc_sample', true],
  ] as const) {
    const page = await prepare(name);
    if (explicit) await timeline(page);
    await submit(page);
    await page.getByRole('button', { name: explicit ? '保存文件' : '保存', exact: true }).waitFor();
    verify(await mediaBytes(page), name);
    results.push('automatic identity key ' + name);
    await page.close();
  }
  for (const name of ['subtitle-valid', 'subtitle-ambiguous']) {
    const page = await prepare(name);
    await timeline(page);
    await page.getByRole('combobox', { name: 'WebVTT 字幕' }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await submit(page);
    await page.getByRole('button', { name: '保存文件', exact: true }).waitFor();
    if (name === 'subtitle-valid') {
      await page.getByRole('button', { name: '保存 WebVTT' }).click();
      assert.match(
        await page.evaluate(() => (window as any).timelineTest.sidecars.at(-1).text()),
        /Aligned cue/,
      );
    } else {
      await page.getByText('字幕导出失败', { exact: false }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: '保存文件' }).count(), 1);
    }
    results.push(name);
    await page.close();
  }
  assert.deepEqual(errors, []);
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  writeFileSync(
    resolve(root, 'test-results/app-web-timeline.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(`PASS Web M2: ${results.length} cases, real WASM and FFmpeg decode`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
