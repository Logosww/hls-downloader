import { chromium, type Page } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const baseURL = process.env.HLS_APP_WEB_URL ?? 'http://localhost:3100';
const browser = await chromium.launch({ executablePath: process.env.HLS_TEST_CHROMIUM_PATH });
const results: string[] = [];
const errors: string[] = [];

async function prepare(page: Page, supported = true) {
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://hls-fixture.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const name = path.endsWith('.m3u8') ? 'media.m3u8' : path.split('/').at(-1)!;
    await route.fulfill({
      body: readFileSync(resolve(root, 'test/fixtures/media/ts', name)),
      headers: {
        'access-control-allow-origin': '*',
        'content-type': path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
      },
    });
  });
  await page.addInitScript(
    ({ supported }) => {
      const state = ((window as any).fileTest = {
        selected: 0,
        opened: [] as string[],
        saved: [] as string[],
        aborted: [] as string[],
        activeGestures: [] as boolean[],
        mode: 'ok',
        releases: {} as Record<string, () => void>,
        failWrite: false,
        blobCount: 0,
      });
      const createURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object) => {
        state.blobCount++;
        return createURL(object);
      };
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: supported
          ? async () => {
              state.activeGestures.push(navigator.userActivation.isActive);
              if (state.mode === 'cancel') throw new DOMException('Picker cancelled', 'AbortError');
              if (state.mode === 'denied')
                throw new DOMException('Permission denied', 'NotAllowedError');
              const name = `app-writable-${++state.selected}.mp4`;
              const directory = await navigator.storage.getDirectory();
              const handle = await directory.getFileHandle(name, { create: true });
              const mode = state.mode;
              return {
                name,
                isSameEntry: async (other: { name: string }) => name === other.name,
                async createWritable() {
                  state.opened.push(name);
                  const file = await handle.createWritable();
                  let first = true;
                  return new WritableStream<Uint8Array>({
                    async write(bytes) {
                      if (state.failWrite) throw new Error('Disk full');
                      if (first && mode === 'blocked') {
                        first = false;
                        await new Promise<void>((resolve) => {
                          state.releases[name] = resolve;
                        });
                      }
                      await file.write(bytes);
                    },
                    async close() {
                      await file.close();
                      state.saved.push(name);
                    },
                    async abort(reason) {
                      await file.abort(reason);
                      state.aborted.push(name);
                    },
                  });
                },
              };
            }
          : undefined,
      });
    },
    { supported },
  );
  await page.goto(baseURL);
}
async function openConfirm(page: Page) {
  await page
    .getByRole('textbox', { name: '请输入 HLS 链接' })
    .fill('https://hls-fixture.test/media.m3u8');
  await page.getByRole('button', { name: '下载', exact: true }).click();
  await page.getByRole('alertdialog').waitFor();
}
async function selectFile(page: Page) {
  await openConfirm(page);
  await page.getByRole('button', { name: '选择位置并下载' }).click();
}

try {
  const page = await browser.newPage();
  await prepare(page);
  await openConfirm(page);
  assert.equal(
    await page.getByRole('radio', { name: /大文件直存/ }).getAttribute('aria-checked'),
    'true',
  );
  assert.equal(await page.getByRole('button', { name: 'H.264', exact: true }).isDisabled(), true);
  const before = await page.evaluate(() => (window as any).fileTest.blobCount);
  await page.getByRole('button', { name: '选择位置并下载' }).click();
  await page.getByRole('button', { name: '已保存', exact: true }).waitFor();
  const direct = await page.evaluate(async () => {
    const s = (window as any).fileTest;
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(s.saved[0]);
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    return {
      ...s,
      size: bytes.length,
      box: new TextDecoder().decode(bytes.slice(4, 8)),
      releases: undefined,
    };
  });
  assert.equal(direct.blobCount, before);
  assert.equal(direct.box, 'ftyp');
  assert.ok(direct.size > 1000);
  assert.equal(direct.activeGestures.every(Boolean), true);
  results.push(
    'File picker runs during user activation; real WASM writes OPFS and finishes saved without a Blob URL.',
  );

  // Cancelling or denying the picker keeps the confirmation open and adds no task.
  for (const mode of ['cancel', 'denied']) {
    await page.evaluate((mode) => {
      (window as any).fileTest.mode = mode;
    }, mode);
    await selectFile(page);
    assert.equal(await page.getByRole('alertdialog').count(), 1);
    assert.equal(await page.evaluate(() => (window as any).fileTest.selected), 1);
    await page.getByRole('button', { name: '取消', exact: true }).click();
  }
  results.push('Picker cancellation/permission errors do not enqueue or silently fall back.');

  // Queue four file handles, only open three writers, cancel the queued one.
  await page.evaluate(() => {
    (window as any).fileTest.mode = 'blocked';
  });
  for (let i = 0; i < 4; i++) await selectFile(page);
  await page.waitForFunction(() => Object.keys((window as any).fileTest.releases).length === 3);
  assert.equal(await page.evaluate(() => (window as any).fileTest.opened.length), 4); // first success + 3 active
  await page.getByRole('button', { name: '取消 app-writable-5.mp4' }).click();
  await page.getByRole('button', { name: '取消 app-writable-2.mp4' }).click();
  await page.evaluate(() => {
    for (const release of Object.values((window as any).fileTest.releases))
      (release as () => void)();
  });
  await page.waitForFunction(() => (window as any).fileTest.saved.length === 3);
  assert.equal(
    await page.evaluate(() => (window as any).fileTest.opened.includes('app-writable-5.mp4')),
    false,
  );
  await page.getByRole('button', { name: '删除 app-writable-5.mp4' }).click();
  results.push(
    'Three-worker queue, queued cancellation, independent active cancellation and removal work.',
  );

  await page.evaluate(() => {
    (window as any).fileTest.mode = 'ok';
    (window as any).fileTest.failWrite = true;
  });
  await selectFile(page);
  await page.getByRole('alert').filter({ hasText: '文件写入失败' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).count(), 0);
  results.push('Write failure is visible and does not offer a misleading Save action.');

  // Preserve legacy mode and its transcode controls.
  await page.evaluate(() => {
    (window as any).fileTest.failWrite = false;
  });
  await openConfirm(page);
  await page.getByRole('radio', { name: /普通下载/ }).check();
  assert.equal(await page.getByRole('button', { name: 'H.264', exact: true }).isEnabled(), true);
  await page.getByRole('alertdialog').getByRole('button', { name: '下载', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).waitFor();
  results.push(
    'Legacy download still produces a manually saved result with transcode controls available.',
  );

  const unsupported = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await prepare(unsupported, false);
  await openConfirm(unsupported);
  assert.equal(await unsupported.getByRole('radio', { name: /大文件直存/ }).isDisabled(), true);
  assert.equal(
    await unsupported.getByRole('radio', { name: /普通下载/ }).getAttribute('aria-checked'),
    'true',
  );
  assert.equal(
    await unsupported.getByText('此浏览器暂不支持文件直存', { exact: false }).count(),
    1,
  );
  assert.ok(await unsupported.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  mkdirSync(resolve(root, 'test-results'), { recursive: true });
  await unsupported.getByRole('alertdialog').evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  await unsupported.screenshot({
    path: resolve(root, 'test-results/app-web-unsupported-mobile.png'),
    fullPage: true,
  });
  await unsupported
    .getByRole('alertdialog')
    .getByRole('button', { name: '下载', exact: true })
    .click();
  await unsupported.getByRole('button', { name: '保存', exact: true }).waitFor();
  const download = unsupported.waitForEvent('download');
  await unsupported.getByRole('button', { name: '保存', exact: true }).click();
  await download;
  results.push(
    'Unsupported browser defaults to legacy mode and retains anchor-download fallback at mobile width.',
  );

  await openConfirm(page);
  await page.getByRole('radio', { name: /大文件直存/ }).check();
  await page.getByRole('alertdialog').evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  await page.screenshot({
    path: resolve(root, 'test-results/app-web-writable.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(results.join('\n'));
} finally {
  await browser.close();
}
