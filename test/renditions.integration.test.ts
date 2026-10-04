import { shiftTsTimestamps } from './fixtures/continuous-ts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { startFixtureServer, sendBytes, sendText, sendRange } from './fixtures/http-server';
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  if (String(input).startsWith('file:') && String(input).endsWith('.wasm'))
    return new Response(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
        ),
      ),
      { headers: { 'content-type': 'application/wasm' } },
    );
  return originalFetch(input, init);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});
const servers: Awaited<ReturnType<typeof startFixtureServer>>[] = [];
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true });
});
async function fixture(
  format: 'ts' | 'fmp4' = 'ts',
  ranged = false,
  audioShift = 0,
  clockShift = 0,
  shortAudio = false,
) {
  const routes: Parameters<typeof startFixtureServer>[0] = {
    '/master.m3u8': (_, res) =>
      sendText(
        res,
        `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/media.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90,AUDIO="a",SUBTITLES="s"\nvideo/media.m3u8\n`,
      ),
    '/sub.m3u8': (_, res) =>
      sendText(res, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsub.vtt\n#EXT-X-ENDLIST\n'),
    '/sub.vtt': (_, res) =>
      sendText(
        res,
        `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${format === 'ts' ? 126000 : 0}\n\n00:00:00.500 --> 00:00:01.000 align:start\nHello\n`,
      ),
  };
  for (const [prefix, folder] of [
    ['video', format],
    ['audio', 'audio-' + format],
  ]) {
    const base = resolve(import.meta.dirname, 'fixtures/media', folder!);
    for (const name of readdirSync(base))
      routes[`/${prefix}/${name}`] = (_, res) =>
        sendBytes(
          res,
          name.endsWith('.ts') && (clockShift !== 0 || (prefix === 'audio' && audioShift !== 0))
            ? shiftTsTimestamps(
                readFileSync(join(base, name)),
                clockShift + (prefix === 'audio' ? audioShift : 0),
              )
            : readFileSync(join(base, name)),
        );
    if (shortAudio && prefix === 'audio')
      routes['/audio/media.m3u8'] = (_, res) =>
        sendText(
          res,
          '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.6,\nsegment-00.ts\n#EXT-X-ENDLIST\n',
        );
    if (ranged) {
      let offset = 0;
      const pieces: Buffer[] = [];
      const add = (name: string) => {
        const b = readFileSync(join(base, name));
        const range = `${b.length}@${offset}`;
        offset += b.length;
        pieces.push(b);
        return range;
      };
      const playlist = readFileSync(join(base, 'media.m3u8'), 'utf8')
        .split('\n')
        .map((line) => {
          const map = /^#EXT-X-MAP:URI="([^"]+)"/.exec(line);
          if (map) return `#EXT-X-MAP:URI="data.bin",BYTERANGE="${add(map[1]!)}"`;
          if (line && !line.startsWith('#')) return `#EXT-X-BYTERANGE:${add(line)}\ndata.bin`;
          return line;
        })
        .join('\n');
      routes[`/${prefix}/media.m3u8`] = (_, res) => sendText(res, playlist);
      routes[`/${prefix}/data.bin`] = (req, res) => {
        if (prefix === 'audio' && req.attempt === 1) {
          res.writeHead(503).end();
          return;
        }
        sendRange(req, res, Buffer.concat(pieces));
      };
    }
  }
  const server = await startFixtureServer(routes);
  servers.push(server);
  return server;
}
function probe(bytes: Uint8Array, expectedOffset?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'hls-renditions-'));
  paths.push(dir);
  const file = join(dir, 'output.mp4');
  writeFileSync(file, bytes);
  const result = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', file],
      { encoding: 'utf8' },
    ),
  );
  expect(result.streams.map((s: any) => s.codec_type).sort()).toEqual(['audio', 'video']);
  for (const stream of result.streams) {
    const times = result.packets
      .filter((p: any) => p.stream_index === stream.index)
      .map((p: any) => Number(p.dts_time));
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((t: number, i: number) => i === 0 || t >= times[i - 1])).toBe(true);
  }
  if (expectedOffset !== undefined) {
    const start = (type: string) => {
      const index = result.streams.find((s: any) => s.codec_type === type).index;
      return Number(result.packets.find((p: any) => p.stream_index === index).dts_time);
    };
    expect(Math.abs(start('audio') - start('video') - expectedOffset)).toBeLessThan(0.0001);
  }
  // Count positive zero crossings after decoding: external fixture is 880 Hz, embedded is 440 Hz.
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
  expect(crossings / (samples.length / 48000)).toBeGreaterThan(800);
}
for (const [name, adapter] of [
  ['Browser', BrowserAdapter],
  ['Node', NodeAdapter],
] as const) {
  describe(name + ' rendition contract', () => {
    it('discovers groups and resolves rendition URIs', async () => {
      const s = await fixture();
      const d = new HlsDownloader({ adapter });
      const parsed = await d.parseHls({ url: s.origin + '/master.m3u8' });
      expect(parsed.type).toBe('playlist');
      if (parsed.type !== 'playlist') return;
      expect(parsed.data[0]).toMatchObject({ audioGroup: 'a', subtitlesGroup: 's' });
      expect(parsed.renditions).toContainEqual(
        expect.objectContaining({
          name: 'English',
          type: 'audio',
          uri: s.origin + '/audio/media.m3u8',
        }),
      );
    });
    for (const format of ['ts', 'fmp4'] as const)
      for (const mode of ['download', 'stream', 'writable'] as const) {
        it(`${format} ${mode} replaces embedded audio and keeps media timestamps`, async () => {
          const s = await fixture(format);
          const d = new HlsDownloader({ adapter });
          const options = {
            url: s.origin + '/master.m3u8',
            audio: { language: 'EN' },
            headers: { 'x-contract': 'audio' },
          };
          let bytes: Uint8Array;
          if (mode === 'download') {
            const filename = randomUUID() + '.mp4';
            paths.push(resolve(filename));
            const result = await d.download({ ...options, filename });
            if ('filePath' in result) bytes = readFileSync(result.filePath);
            else {
              bytes = new Uint8Array(await (await fetch(result.blobURL)).arrayBuffer());
              URL.revokeObjectURL(result.blobURL);
            }
          } else {
            const chunks: Uint8Array[] = [];
            if (mode === 'stream')
              await d.downloadToStream(options, (bytes) => {
                chunks.push(bytes);
              });
            else
              await d.downloadToWritable(
                options,
                new WritableStream({
                  async write(bytes) {
                    await new Promise((r) => setTimeout(r, 1));
                    chunks.push(bytes);
                  },
                }),
              );
            bytes = Buffer.concat(chunks);
          }
          probe(bytes);
          expect(s.requests.some((r) => r.path === '/sub.m3u8')).toBe(false);
          expect(s.requests.every((r) => r.headers['x-contract'] === 'audio')).toBe(true);
          expect(s.requests.filter((r) => r.path === '/video/media.m3u8')).toHaveLength(1);
          expect(s.requests.filter((r) => r.path === '/audio/media.m3u8')).toHaveLength(1);
        });
      }
    it.each([-0.2, 0.2])('preserves an external audio offset of %s seconds', async (shift) => {
      const s = await fixture('ts', false, shift);
      const d = new HlsDownloader({ adapter });
      const chunks: Uint8Array[] = [];
      await d.downloadToWritable(
        { url: s.origin + '/master.m3u8' },
        new WritableStream({
          write(b) {
            chunks.push(b);
          },
        }),
      );
      probe(Buffer.concat(chunks), shift - 0.021333);
    });
    it('keeps both inputs aligned across the MPEGTS wrap boundary', async () => {
      const s = await fixture('ts', false, 0, Math.floor(2 ** 33 / 90000) - 2);
      const d = new HlsDownloader({ adapter });
      const chunks: Uint8Array[] = [];
      await d.downloadToWritable(
        { url: s.origin + '/master.m3u8' },
        new WritableStream({
          write(bytes) {
            chunks.push(bytes);
          },
        }),
      );
      probe(Buffer.concat(chunks), -0.021333);
    });
    it('finishes when the selected audio ends before the video', async () => {
      const s = await fixture('ts', false, 0, 0, true);
      const d = new HlsDownloader({ adapter });
      const chunks: Uint8Array[] = [];
      const result = await d.downloadToWritable(
        { url: s.origin + '/master.m3u8' },
        new WritableStream({
          write(bytes) {
            chunks.push(bytes);
          },
        }),
      );
      expect(result.totalSegments).toBe(3);
      probe(Buffer.concat(chunks), -0.021333);
    });
    it('preserves MAP and byte ranges on both inputs through a retry', async () => {
      const s = await fixture('fmp4', true);
      const d = new HlsDownloader({ adapter });
      const chunks: Uint8Array[] = [];
      await d.downloadToWritable(
        { url: s.origin + '/master.m3u8', maxRetry: 2, downloadConcurrency: 1 },
        new WritableStream({
          write(b) {
            chunks.push(b);
          },
        }),
      );
      probe(Buffer.concat(chunks));
      expect(
        s.requests
          .filter((r) => r.path.endsWith('/data.bin'))
          .every((r) => r.headers.range?.startsWith('bytes=')),
      ).toBe(true);
      expect(s.requests.filter((r) => r.path === '/audio/data.bin').length).toBeGreaterThan(4);
    });
    it('reports close failure once and releases the writer', async () => {
      const s = await fixture();
      let count = 0;
      const d = new HlsDownloader({
        adapter,
        onEvent(e) {
          if (e === 'error') count++;
        },
      });
      const sink = new WritableStream({
        write() {},
        async close() {
          throw new Error('close failed');
        },
      });
      await expect(
        d.downloadToWritable({ url: s.origin + '/master.m3u8' }, sink),
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
      expect(count).toBe(1);
      expect(sink.locked).toBe(false);
    });
    it('rejects a locked destination before any request', async () => {
      const s = await fixture();
      const d = new HlsDownloader({ adapter });
      const sink = new WritableStream<Uint8Array>();
      const writer = sink.getWriter();
      try {
        await expect(
          d.downloadToWritable({ url: s.origin + '/master.m3u8' }, sink),
        ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
        expect(s.requests).toHaveLength(0);
      } finally {
        writer.releaseLock();
      }
    });
    it('isolates concurrent dual-input operations when one is cancelled', async () => {
      const s = await fixture();
      const seen: string[] = [];
      const d = new HlsDownloader({
        adapter,
        onEvent(e, p) {
          if (e === 'ready-for-download') seen.push(p.operationId);
        },
      });
      const abort = new AbortController();
      const cancelled = d.downloadToWritable(
        { url: s.origin + '/master.m3u8', operationId: 'cancel', signal: abort.signal },
        new WritableStream({
          write() {
            abort.abort();
          },
        }),
      );
      const check = expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' });
      const success = d.downloadToWritable(
        { url: s.origin + '/master.m3u8', operationId: 'keep' },
        new WritableStream({ write() {} }),
      );
      await Promise.all([check, success]);
      expect(seen).toEqual(['keep']);
    });
    it('exports subtitles on the shared timeline without reading full media', async () => {
      const s = await fixture();
      const d = new HlsDownloader({ adapter });
      const r = await d.downloadSubtitles({
        url: s.origin + '/master.m3u8',
        subtitle: { groupId: 's', name: 'English' },
      });
      expect(r.mimeType).toBe('text/vtt');
      expect(r.text).toContain('00:00:00.500 --> 00:00:01.000 align:start');
      expect(s.requests.filter((r) => r.path.startsWith('/audio/segment-')).length).toBeLessThan(4);
    });
    it('rejects implicit alternate audio with copy transcoding before reading media', async () => {
      const s = await fixture();
      const d = new HlsDownloader({ adapter });
      await expect(
        d.download({
          url: s.origin + '/master.m3u8',
          transcode: { videoCodec: 'copy', audioCodec: 'copy' },
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
      expect(s.requests).toHaveLength(1);
    });
    it('rejects missing audio before media requests', async () => {
      const s = await fixture();
      const d = new HlsDownloader({ adapter });
      await expect(
        d.downloadToWritable(
          { url: s.origin + '/master.m3u8', audio: { language: 'missing' } },
          new WritableStream(),
        ),
      ).rejects.toMatchObject({ code: 'RENDITION_NOT_FOUND' });
      expect(s.requests).toHaveLength(1);
    });
    it('waits for close and normalizes asynchronous sink failure once', async () => {
      const s = await fixture();
      const errors: unknown[] = [];
      const d = new HlsDownloader({
        adapter,
        onEvent(e, p) {
          if (e === 'error') errors.push(p);
        },
      });
      let writes = 0;
      const sink = new WritableStream({
        async write() {
          writes++;
          throw new Error('sink');
        },
      });
      await expect(
        d.downloadToWritable({ url: s.origin + '/master.m3u8' }, sink),
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
      expect(errors).toHaveLength(1);
      expect(writes).toBe(1);
      expect(sink.locked).toBe(false);
    });
    it('cancels an indefinitely blocked sink', async () => {
      const s = await fixture();
      const d = new HlsDownloader({ adapter });
      const controller = new AbortController();
      let started!: () => void;
      const ready = new Promise<void>((r) => {
        started = r;
      });
      const sink = new WritableStream({
        write() {
          started();
          return new Promise<void>(() => {});
        },
      });
      const task = d.downloadToWritable(
        { url: s.origin + '/master.m3u8', signal: controller.signal },
        sink,
      );
      const rejected = expect(task).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
      await ready;
      controller.abort();
      await rejected;
      expect(sink.locked).toBe(false);
    });
  });
}

describe('Node file publication', () => {
  it('preserves ordinary filenames and cleans up failed publication', async () => {
    const previousCwd = process.cwd();
    const workDir = mkdtempSync(join(tmpdir(), 'hls-publication-'));
    paths.push(workDir);
    process.chdir(workDir);
    try {
      const s = await fixture();
      const d = new HlsDownloader({ adapter: NodeAdapter });
      const filename = resolve(randomUUID() + '..selected.mp4');
      paths.push(filename);
      const result = await d.download({ url: s.origin + '/master.m3u8', filename });
      expect(result.filePath).toBe(filename);
      expect(readFileSync(filename).length).toBeGreaterThan(0);
      const blocked = resolve(randomUUID() + '.mp4');
      mkdirSync(blocked);
      paths.push(blocked);
      const before = readdirSync(workDir).sort();
      await expect(
        d.download({ url: s.origin + '/master.m3u8', filename: blocked }),
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
      expect(readdirSync(workDir).sort()).toEqual(before);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('Browser dual-input request policy', () => {
  it('shares the read budget and propagates browser request context to both inputs', async () => {
    const s = await fixture();
    const d = new HlsDownloader({ adapter: BrowserAdapter });
    let active = 0;
    let peak = 0;
    const requested: string[] = [];
    await d.downloadToWritable(
      {
        url: s.origin + '/master.m3u8',
        downloadConcurrency: 1,
        headers: { Authorization: 'Bearer fixture' },
        browserRequest: {
          credentials: 'include',
          async fetch(input, init) {
            expect(init?.credentials).toBe('include');
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture');
            requested.push(String(input));
            peak = Math.max(peak, ++active);
            try {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return await originalFetch(input, init);
            } finally {
              active--;
            }
          },
        },
      },
      new WritableStream(),
    );
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(requested.some((url) => url.includes('/video/segment-'))).toBe(true);
    expect(requested.some((url) => url.includes('/audio/segment-'))).toBe(true);
    expect(s.requests.every((r) => r.headers.authorization === 'Bearer fixture')).toBe(true);
  });
});
