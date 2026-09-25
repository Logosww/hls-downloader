import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { HlsDownloaderEvent, createAdapter, getInternalAdapter } from '@hls-downloader/shared';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { createResourceWindow } from '../packages/adapters/src/browser/writable';
import { startFixtureServer, sendText, sendBytes, sendRange } from './fixtures/http-server';

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures/media', name));
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('file:') && url.endsWith('.wasm'))
    return new Response(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
        ),
      ),
      { headers: { 'content-type': 'application/wasm' } },
    );
  return fetchOriginal(input, init);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = fetchOriginal;
});
const servers: Awaited<ReturnType<typeof startFixtureServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const playlist = (n: number) =>
  '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' +
  Array.from({ length: n }, (_, i) => `#EXTINF:2,\nsegment.ts?i=${i}\n`).join('') +
  '#EXT-X-ENDLIST\n';
async function server(n = 10) {
  const s = await startFixtureServer({
    '/media.m3u8': (_, res) => sendText(res, playlist(n)),
    '/segment.ts': (_, res) => sendBytes(res, fixture('ts/segment-00.ts')),
  });
  servers.push(s);
  return s;
}

describe('writable output (real WASM)', () => {
  it('starts early, bounds prefetch under backpressure, and waits for close', async () => {
    const s = await server(12);
    const first = deferred();
    const release = deferred();
    const closed = deferred();
    const finish = deferred();
    let writes = 0;
    let settled = false;
    const events: string[] = [];
    const d = new HlsDownloader({ adapter: BrowserAdapter, onEvent: (e) => events.push(e) });
    const sink = new WritableStream<Uint8Array>({
      async write() {
        if (++writes === 1) {
          first.resolve();
          await release.promise;
        }
      },
      async close() {
        closed.resolve();
        await finish.promise;
      },
    });
    const task = d
      .downloadToWritable({ url: s.origin + '/media.m3u8', downloadConcurrency: 2 }, sink)
      .then((r) => {
        settled = true;
        return r;
      });
    await Promise.race([first.promise, task]);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.requests.filter((r) => r.path === '/segment.ts').length).toBe(3);
    expect(settled).toBe(false);
    release.resolve();
    await Promise.race([closed.promise, task]);
    expect(settled).toBe(false);
    expect(events).not.toContain(HlsDownloaderEvent.READY_FOR_DOWNLOAD);
    finish.resolve();
    expect((await task).totalSegments).toBe(12);
    expect(events.filter((e) => e === HlsDownloaderEvent.READY_FOR_DOWNLOAD)).toHaveLength(1);
    expect(sink.locked).toBe(false);
  });

  it.each(['ts', 'fmp4', 'byterange'] as const)(
    'writes valid %s media and preserves tracks/timestamps',
    async (kind) => {
      const s = await startFixtureServer({
        '/media.m3u8': (_, res) => sendText(res, fixture(`${kind}/media.m3u8`).toString()),
        '/segment-00.ts': (_, res) => sendBytes(res, fixture('ts/segment-00.ts')),
        '/segment-01.ts': (_, res) => sendBytes(res, fixture('ts/segment-01.ts')),
        '/init.mp4': (_, res) => sendBytes(res, fixture('fmp4/init.mp4')),
        '/segment-00.m4s': (_, res) => sendBytes(res, fixture('fmp4/segment-00.m4s')),
        '/segment-01.m4s': (_, res) => sendBytes(res, fixture('fmp4/segment-01.m4s')),
        '/media.ts': (req, res) => sendRange(req, res, fixture('byterange/media.ts')),
      });
      servers.push(s);
      const chunks: Uint8Array[] = [];
      const d = new HlsDownloader({
        adapter: BrowserAdapter,
        options: { transcode: { preset: 'hevc' } },
      });
      await d.downloadToWritable(
        { url: s.origin + '/media.m3u8' },
        new WritableStream({
          write(b) {
            chunks.push(b);
          },
        }),
      );
      const bytes = Buffer.concat(chunks);
      expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
      expect(bytes.includes(Buffer.from('moof'))).toBe(true);
      expect(bytes.includes(Buffer.from('mfra'))).toBe(false);
      const dir = mkdtempSync(join(tmpdir(), 'hls-writable-'));
      try {
        const path = join(dir, 'out.mp4');
        writeFileSync(path, bytes);
        const probe = JSON.parse(
          execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_streams', '-show_format', '-show_packets', '-of', 'json', path],
            { encoding: 'utf8' },
          ),
        );
        expect(probe.streams.map((t: { codec_name: string }) => t.codec_name)).toEqual([
          'h264',
          'aac',
        ]);
        expect(Number(probe.format.duration)).toBeGreaterThan(1.8);
        expect(Number(probe.format.duration)).toBeLessThan(2.3);
        const previous = new Map<number, number>();
        for (const packet of probe.packets) {
          const dts = Number(packet.dts);
          expect(dts).toBeGreaterThanOrEqual(previous.get(packet.stream_index) ?? -Infinity);
          previous.set(packet.stream_index, dts);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (kind === 'byterange')
        expect(
          s.requests.filter((r) => r.path === '/media.ts').map((r) => r.headers.range),
        ).toEqual(['bytes=0-31771', 'bytes=31772-62415']);
    },
  );

  it.each(['write', 'close'] as const)(
    'normalizes %s errors and emits only one error',
    async (stage) => {
      const s = await server(2);
      const events: string[] = [];
      const d = new HlsDownloader({ adapter: BrowserAdapter, onEvent: (e) => events.push(e) });
      const sink = new WritableStream<Uint8Array>({
        [stage]() {
          throw new Error('disk full');
        },
      });
      await expect(
        d.downloadToWritable({ url: s.origin + '/media.m3u8' }, sink),
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
      expect(events.filter((e) => e === HlsDownloaderEvent.ERROR)).toHaveLength(1);
      expect(events).not.toContain(HlsDownloaderEvent.READY_FOR_DOWNLOAD);
      expect(sink.locked).toBe(false);
    },
  );

  it('cancels a blocked writer without waiting for an uncooperative sink', async () => {
    const s = await server();
    const started = deferred();
    const release = deferred();
    const controller = new AbortController();
    const d = new HlsDownloader({ adapter: BrowserAdapter });
    const sink = new WritableStream<Uint8Array>({
      async write() {
        started.resolve();
        await release.promise;
      },
    });
    const task = d.downloadToWritable(
      { url: s.origin + '/media.m3u8', signal: controller.signal, downloadConcurrency: 1 },
      sink,
    );
    const rejected = expect(task).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
    await Promise.race([started.promise, task]);
    controller.abort();
    await rejected;
    expect(sink.locked).toBe(false);
    release.resolve();
  });

  it('rejects unsupported adapters, transcode requests and locked streams', async () => {
    const unsupported = createAdapter({
      ...getInternalAdapter(BrowserAdapter),
      capabilities: { ...getInternalAdapter(BrowserAdapter).capabilities, writableOutput: false },
    });
    const sink = new WritableStream<Uint8Array>();
    await expect(
      new HlsDownloader({ adapter: unsupported }).downloadToWritable(
        { url: 'https://invalid/' },
        sink,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
    const d = new HlsDownloader({ adapter: BrowserAdapter });
    // @ts-expect-error Transcoding is intentionally excluded from writable options.
    await expect(
      d.downloadToWritable({ url: 'https://invalid/', transcode: { preset: 'h264' } }, sink),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
    const writer = sink.getWriter();
    await expect(d.downloadToWritable({ url: 'https://invalid/' }, sink)).rejects.toMatchObject({
      code: 'OUTPUT_WRITE_FAILED',
    });
    writer.releaseLock();
  });

  it('retries interrupted bodies without publishing partial media', async () => {
    const bytes = fixture('ts/segment-00.ts');
    const s = await startFixtureServer({
      '/media.m3u8': (_, res) => sendText(res, playlist(1)),
      '/segment.ts': async (req, res) => {
        if (req.attempt === 1) {
          res.writeHead(200, { 'content-length': bytes.length });
          res.write(bytes.subarray(0, 100));
          await new Promise((r) => setTimeout(r, 10));
          res.destroy();
        } else await sendBytes(res, bytes);
      },
    });
    servers.push(s);
    const d = new HlsDownloader({ adapter: BrowserAdapter });
    await d.downloadToWritable(
      { url: s.origin + '/media.m3u8', maxRetry: 2 },
      new WritableStream(),
    );
    expect(s.attempts.get('/segment.ts')).toBe(2);
  });

  it('slices a full 200 response for implicit byte ranges', async () => {
    const s = await startFixtureServer({
      '/media.m3u8': (_, res) =>
        sendText(res, fixture('byterange/media.m3u8').toString().replace('30644@31772', '30644')),
      '/media.ts': (_, res) => sendBytes(res, fixture('byterange/media.ts')),
    });
    servers.push(s);
    await new HlsDownloader({ adapter: BrowserAdapter }).downloadToWritable(
      { url: s.origin + '/media.m3u8' },
      new WritableStream(),
    );
    expect(s.requests.filter((r) => r.path === '/media.ts').map((r) => r.headers.range)).toEqual([
      'bytes=0-31771',
      'bytes=31772-62415',
    ]);
  });

  it.each(['fetch', 'retry'] as const)(
    'cancels during %s and closes the response',
    async (mode) => {
      const requested = deferred();
      const disconnected = deferred();
      const s = await startFixtureServer({
        '/media.m3u8': (_, res) => sendText(res, playlist(1)),
        '/segment.ts': (_, res) => {
          res.on('close', disconnected.resolve);
          if (mode === 'retry') res.writeHead(503).end();
          else {
            res.writeHead(200);
            res.write(fixture('ts/segment-00.ts').subarray(0, 100));
          }
          requested.resolve();
        },
      });
      servers.push(s);
      const controller = new AbortController();
      let aborted = 0;
      const d = new HlsDownloader({ adapter: BrowserAdapter });
      const task = d.downloadToWritable(
        { url: s.origin + '/media.m3u8', signal: controller.signal },
        new WritableStream({
          abort() {
            aborted++;
          },
        }),
      );
      const rejected = expect(task).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
      await requested.promise;
      if (mode === 'retry') await new Promise((r) => setTimeout(r, 30));
      controller.abort();
      await rejected;
      await disconnected.promise;
      expect(aborted).toBe(1);
      expect(s.attempts.get('/segment.ts')).toBe(1);
    },
  );

  it('isolates three operations and cancels only the selected operation', async () => {
    const s = await server(5);
    const first = deferred();
    const blocked = deferred();
    const events: Array<[string, string]> = [];
    const d = new HlsDownloader({
      adapter: BrowserAdapter,
      onEvent: (e, p) => events.push([e, p.operationId]),
    });
    const controller = new AbortController();
    const cancelled = d.downloadToWritable(
      { url: s.origin + '/media.m3u8', operationId: 'cancel', signal: controller.signal },
      new WritableStream({
        async write() {
          first.resolve();
          await blocked.promise;
        },
      }),
    );
    const rejection = expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' });
    const rest = ['one', 'two'].map((operationId) =>
      d.downloadToWritable({ url: s.origin + '/media.m3u8', operationId }, new WritableStream()),
    );
    await first.promise;
    controller.abort();
    await rejection;
    blocked.resolve();
    expect((await Promise.all(rest)).map((r) => r.operationId)).toEqual(['one', 'two']);
    expect(events.filter(([e]) => e === HlsDownloaderEvent.ERROR)).toEqual([
      [HlsDownloaderEvent.ERROR, 'cancel'],
    ]);
    expect(
      events
        .filter(([e]) => e === HlsDownloaderEvent.READY_FOR_DOWNLOAD)
        .map(([, id]) => id)
        .sort(),
    ).toEqual(['one', 'two']);
  });

  it('stops a blocked writer when speculative prefetch fails', async () => {
    const writing = deferred();
    const release = deferred();
    const s = await startFixtureServer({
      '/media.m3u8': (_, res) => sendText(res, playlist(2)),
      '/segment.ts': async (req, res) => {
        if (req.query.get('i') === '0') await sendBytes(res, fixture('ts/segment-00.ts'));
        else {
          await writing.promise;
          res.writeHead(404).end();
        }
      },
    });
    servers.push(s);
    const sink = new WritableStream<Uint8Array>({
      async write() {
        writing.resolve();
        await release.promise;
      },
    });
    const task = new HlsDownloader({ adapter: BrowserAdapter }).downloadToWritable(
      { url: s.origin + '/media.m3u8', downloadConcurrency: 1 },
      sink,
    );
    await expect(task).rejects.toMatchObject({ code: 'SEGMENT_FETCH_FAILED' });
    expect(sink.locked).toBe(false);
    release.resolve();
  });

  it.each([
    ['AES-128', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', 'UNSUPPORTED_ENCRYPTION'],
    ['SAMPLE-AES', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"', 'UNSUPPORTED_ENCRYPTION'],
    ['discontinuity', '#EXT-X-DISCONTINUITY', 'TRANSMUX_FAILED'],
    ['event', '#EXT-X-PLAYLIST-TYPE:EVENT', 'TRANSMUX_FAILED'],
  ])('rejects unsupported %s before requesting media', async (_, tag, code) => {
    const s = await startFixtureServer({
      '/media.m3u8': (_, res) =>
        sendText(
          res,
          '#EXTM3U\n#EXT-X-TARGETDURATION:1\n' + tag + '\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n',
        ),
    });
    servers.push(s);
    await expect(
      new HlsDownloader({ adapter: BrowserAdapter }).downloadToWritable(
        { url: s.origin + '/media.m3u8' },
        new WritableStream(),
      ),
    ).rejects.toMatchObject({ code });
    expect(s.requests).toHaveLength(1);
  });

  it('resolves redirected master/media URLs and keeps query strings and headers', async () => {
    const s = await startFixtureServer({
      '/start': (_, res) => {
        res.writeHead(302, { location: '/nested/master.m3u8' }).end();
      },
      '/nested/master.m3u8': (_, res) =>
        sendText(res, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n../media.m3u8?token=1\n'),
      '/media.m3u8': (_, res) => {
        res.writeHead(302, { location: '/final/media.m3u8?token=1' }).end();
      },
      '/final/media.m3u8': (_, res) =>
        sendText(
          res,
          '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n../segment.ts?part=1\n#EXT-X-ENDLIST\n',
        ),
      '/segment.ts': (_, res) => sendBytes(res, fixture('ts/segment-00.ts')),
    });
    servers.push(s);
    await new HlsDownloader({ adapter: BrowserAdapter }).downloadToWritable(
      { url: s.origin + '/start', headers: { 'x-test-header': 'present' } },
      new WritableStream(),
    );
    expect(s.requests.every((r) => r.headers['x-test-header'] === 'present')).toBe(true);
    expect(s.requests.filter((r) => r.path === '/final/media.m3u8')).toHaveLength(1);
    expect(s.requests.filter((r) => r.path === '/segment.ts')).toHaveLength(1);
    expect(s.requests.find((r) => r.path === '/segment.ts')?.query.get('part')).toBe('1');
  });

  it.each([100, 1_000, 10_000])('bounds the resource window for %i segments', async (count) => {
    const controller = new AbortController();
    const segments = Array.from({ length: count }, (_, i) => ({
      uri: `https://fixture/${i}`,
      duration: 2,
    }));
    const window = createResourceWindow(
      segments,
      3,
      async () => new Uint8Array(1024),
      controller.signal,
      () => {},
    );
    for (const segment of segments) {
      expect((await window.read(segment.uri)).length).toBe(1024);
      expect(window.size).toBeLessThanOrEqual(3);
    }
    expect(window.peak).toBe(3);
    window.dispose();
    expect(window.size).toBe(0);
  });
});
