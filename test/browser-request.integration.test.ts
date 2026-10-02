import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { readResource } from '../packages/adapters/src/browser/writable';
import type { HlsDownloaderBrowserRequestOptions } from '@hls-downloader/shared';

const url = 'https://media.test/list.m3u8';
const manifest = (name = 'segment.ts') =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n${name}\n#EXT-X-ENDLIST\n`;
const media = (name: string) => readFileSync(resolve(import.meta.dirname, 'fixtures/media', name));
const wasm = () =>
  new Response(
    readFileSync(
      resolve(
        import.meta.dirname,
        '../packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
      ),
    ),
    { headers: { 'Content-Type': 'application/wasm' } },
  );
afterEach(() => vi.unstubAllGlobals());

function downloader(browserRequest?: HlsDownloaderBrowserRequestOptions) {
  return new HlsDownloader({
    adapter: BrowserAdapter,
    options: { browserRequest, download: { maxRetry: 2 } },
  });
}

describe('browser request contexts', () => {
  it('inherits credentials and headers, replaces per call, and keeps native defaults', async () => {
    const native = vi.fn(async () => new Response(manifest('native.ts')));
    vi.stubGlobal('fetch', native);
    const transport = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(manifest('custom.ts')),
    );
    const d = downloader({ fetch: transport, credentials: 'include' });
    expect(await d.parseHls({ url, headers: { Authorization: 'test' } })).toMatchObject({
      type: 'segment',
      data: [{ uri: 'https://media.test/custom.ts' }],
    });
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
    expect(
      new Headers((transport.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get(
        'Authorization',
      ),
    ).toBe('test');
    await d.parseHls({ url, browserRequest: {} });
    expect(native).toHaveBeenCalledOnce();
    expect(
      (native.mock.calls[0] as unknown as [string, RequestInit])[1].credentials,
    ).toBeUndefined();
    expect(transport).toHaveBeenCalledOnce();
  });

  it('isolates identical URLs across instances, concurrent calls and changed login state', async () => {
    let account = 'a';
    const d = downloader({ fetch: async () => new Response(manifest(`${account}.ts`)) });
    expect(await d.parseHls({ url })).toMatchObject({ data: [{ uri: 'https://media.test/a.ts' }] });
    account = 'b';
    expect(await d.parseHls({ url })).toMatchObject({ data: [{ uri: 'https://media.test/b.ts' }] });
    const other = downloader({ fetch: async () => new Response(manifest('c.ts')) });
    const results = await Promise.all([
      d.parseHls({ url }),
      other.parseHls({ url }),
      d.parseHls({ url, browserRequest: { fetch: async () => new Response(manifest('d.ts')) } }),
    ]);
    expect(results.map((r) => r.type === 'segment' && r.data[0]?.uri)).toEqual([
      'https://media.test/b.ts',
      'https://media.test/c.ts',
      'https://media.test/d.ts',
    ]);
    d.clearCache();
  });

  it.each([401, 403])(
    'preserves HTTP %s without retries or credential diagnostics',
    async (status) => {
      const fetch = vi.fn(async () => new Response(null, { status }));
      const result = await downloader({ fetch }).parseHls({
        url: url + '?token=secret',
        headers: { Authorization: 'secret' },
      });
      expect(result).toMatchObject({
        type: 'error',
        error: { code: 'MANIFEST_FETCH_FAILED', status, attempt: 1, url },
      });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('retries broken response bodies and does not retain failures or partial bytes', async () => {
    let count = 0;
    const fetch = vi.fn(async () =>
      ++count === 1
        ? new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('partial'));
                c.error(new Error('Authorization: secret'));
              },
            }),
          )
        : new Response(manifest()),
    );
    expect(await downloader({ fetch }).parseHls({ url })).toMatchObject({ type: 'segment' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const broken = await downloader({
      fetch: async () => {
        throw new Error('Cookie: secret');
      },
    }).parseHls({ url });
    expect(JSON.stringify(broken)).not.toContain('secret');
    expect(broken).toMatchObject({ error: { code: 'MANIFEST_FETCH_FAILED', attempt: 2 } });
  });

  it('cancels async preparation promptly and disposes a late response', async () => {
    const controller = new AbortController();
    let finish!: (r: Response) => void;
    const cancel = vi.fn();
    const fetch = vi.fn(
      () =>
        new Promise<Response>((r) => {
          finish = r;
        }),
    );
    const pending = downloader({ fetch }).parseHls({ url, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new Error('secret'));
    expect(await pending).toMatchObject({ error: { code: 'ABORTED' } });
    finish(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('cancels a blocked response body and retry backoff', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    const pending = downloader({ fetch }).parseHls({ url, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toMatchObject({ error: { code: 'ABORTED' } });
    expect(cancel).toHaveBeenCalledOnce();
    const retryController = new AbortController();
    const retry = vi.fn(async () => new Response(null, { status: 503 }));
    const retried = downloader({ fetch: retry }).parseHls({ url, signal: retryController.signal });
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    retryController.abort();
    expect(await retried).toMatchObject({ error: { code: 'ABORTED' } });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('uses redirected response URLs and forwards Range and cancellation', async () => {
    const fetch = vi.fn(async () => {
      const response = new Response(manifest('../segment.ts'));
      Object.defineProperty(response, 'url', { value: 'https://cdn.test/sub/list.m3u8' });
      return response;
    });
    expect(await downloader({ fetch }).parseHls({ url })).toMatchObject({
      data: [{ uri: 'https://cdn.test/segment.ts' }],
    });
    const controller = new AbortController();
    const ranged = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('Range')).toBe('bytes=2-4');
      expect(init.signal).toBe(controller.signal);
      return new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: { 'Content-Range': 'bytes 2-4/10' },
      });
    });
    expect(
      (
        await readResource(
          { url, range: { offset: 2, length: 3 } },
          {},
          2,
          controller.signal,
          undefined,
          { fetch: ranged },
        )
      ).bytes,
    ).toEqual(new Uint8Array([2, 3, 4]));
  });

  it.each(['download', 'downloadToStream', 'downloadToWritable', 'getPosterUrl'] as const)(
    'routes every %s media read through the selected transport',
    async (operation) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          expect(String(input)).toContain('hls_transmux_browser_wasm_bg.wasm');
          return wasm();
        }),
      );
      const seen: string[] = [];
      const fetch = async (input: string, init: RequestInit) => {
        expect(init.credentials).toBe('include');
        seen.push(input);
        const path = new URL(input).pathname;
        if (path === '/master.m3u8')
          return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nfmp4/media.m3u8\n');
        return new Response(media(path.slice(1)));
      };
      const d = downloader({ fetch, credentials: 'include' });
      const options = { url: 'https://media.test/master.m3u8' };
      if (operation === 'download') {
        const result = await d.download(options);
        URL.revokeObjectURL(result.blobURL);
      } else if (operation === 'downloadToStream') await d.downloadToStream(options, () => {});
      else if (operation === 'downloadToWritable')
        await d.downloadToWritable(options, new WritableStream({ write() {} }));
      else await d.getPosterUrl(options);
      expect(seen).toContain('https://media.test/fmp4/init.mp4');
      expect(seen).toContain('https://media.test/fmp4/segment-00.m4s');
      if (operation === 'getPosterUrl') {
        await d.getPosterUrl(options);
        expect(seen.filter((u) => u.endsWith('init.mp4'))).toHaveLength(2);
      }
    },
  );

  it('does not retry transport cancellation and reports poster HTTP failures', async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    expect(await downloader({ fetch }).parseHls({ url })).toMatchObject({
      error: { code: 'ABORTED' },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const d = downloader({
      fetch: async (input) =>
        input.endsWith('.m3u8') ? new Response(manifest()) : new Response(null, { status: 403 }),
    });
    await expect(d.getPosterUrl({ url })).rejects.toMatchObject({
      code: 'SEGMENT_FETCH_FAILED',
      status: 403,
    });
  });

  it('freezes instance and per-call options before async initialization', async () => {
    const seen: string[] = [];
    const transport = async (input: string) => {
      seen.push(input);
      return new Response(media(new URL(input).pathname.slice(1)));
    };
    const request = { fetch: transport };
    const d = downloader(request);
    vi.stubGlobal('fetch', async () => wasm());
    const pending = d.downloadToWritable(
      { url: 'https://media.test/fmp4/media.m3u8', browserRequest: request },
      new WritableStream(),
    );
    request.fetch = async () => {
      throw new Error('changed');
    };
    d.setOptions({ browserRequest: { fetch: request.fetch } });
    await pending;
    expect(seen.length).toBeGreaterThan(2);
  });
});
