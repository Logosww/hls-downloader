import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HlsDownloader as SourceDownloader } from '../packages/core/src/index';
import { BrowserAdapter as SourceBrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter as SourceNodeAdapter } from '../packages/adapters/src/node/index';
import {
  HlsDownloaderEvent,
  type HlsKeyRequest,
  type HlsKeyResolver,
} from '../packages/shared/src/index';
import { encryptedRoutes, encrypt, key, sequence } from './fixtures/encrypted';
import { startFixtureServer, sendText, sendBytes } from './fixtures/http-server';
const { HlsDownloader, BrowserAdapter, NodeAdapter } =
  process.env.HLS_KEYED_DIST === '1'
    ? await import('../dist/index.js')
    : {
        HlsDownloader: SourceDownloader,
        BrowserAdapter: SourceBrowserAdapter,
        NodeAdapter: SourceNodeAdapter,
      };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) =>
  String(input).startsWith('file:') && String(input).endsWith('.wasm')
    ? new Response(
        readFileSync(
          resolve(
            import.meta.dirname,
            '../packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
          ),
        ),
        { headers: { 'content-type': 'application/wasm' } },
      )
    : originalFetch(input, init)) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});
const servers: Awaited<ReturnType<typeof startFixtureServer>>[] = [];
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const p of paths.splice(0)) rmSync(p, { recursive: true, force: true });
});
async function fixture(format = 'ts', audio = false, mixed = false) {
  const server = await startFixtureServer(encryptedRoutes(format, audio, mixed));
  servers.push(server);
  return server;
}
function path() {
  const p = resolve(tmpdir(), `keyed-${randomUUID()}.mp4`);
  paths.push(p);
  return p;
}
for (const [name, adapter] of [
  ['browser', BrowserAdapter],
  ['node', NodeAdapter],
] as const) {
  describe(`${name} keyed runtime`, () => {
    for (const format of ['ts', 'fmp4', 'hevc-ts', 'hevc-fmp4'])
      for (const audio of [false, true])
        for (const mode of ['download', 'stream', 'writable']) {
          it(`${format} ${audio ? 'external audio' : 'single'} ${mode}`, async () => {
            const server = await fixture(format, audio, true);
            const requests: HlsKeyRequest[] = [];
            const progress: any[] = [];
            const d = new HlsDownloader({
              adapter,
              onEvent: (event, p) => {
                if (event === HlsDownloaderEvent.DECRYPTION_PROGRESS) progress.push(p);
              },
            });
            const options = {
              url: server.origin + (audio ? '/master.m3u8' : '/video/media.m3u8'),
              filename: path(),
              decryption: {
                keyResolver: async (r: HlsKeyRequest) => {
                  requests.push(r);
                  return { key };
                },
              },
            };
            let bytes: Uint8Array;
            if (mode === 'download') {
              const r = await d.download(options);
              if ('blobURL' in r) {
                bytes = new Uint8Array(await (await fetch(r.blobURL)).arrayBuffer());
                URL.revokeObjectURL(r.blobURL);
              } else {
                paths.push(r.filePath);
                bytes = readFileSync(r.filePath);
              }
            } else {
              const chunks: Uint8Array[] = [];
              let pending = false;
              if (mode === 'stream') await d.downloadToStream(options, (b) => chunks.push(b));
              else
                await d.downloadToWritable(
                  options,
                  new WritableStream({
                    async write(b) {
                      expect(pending).toBe(false);
                      pending = true;
                      await new Promise((r) => setTimeout(r, 1));
                      chunks.push(b);
                      pending = false;
                    },
                  }),
                );
              bytes = Buffer.concat(chunks);
            }
            const output = path();
            writeFileSync(output, bytes);
            execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
            const probe = JSON.parse(
              execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
                encoding: 'utf8',
              }),
            );
            expect(probe.streams.map((s: any) => s.codec_name).sort()).toEqual([
              'aac',
              format.startsWith('hevc') ? 'hevc' : 'h264',
            ]);
            // Decode against the independent clear source, not another keyed output.
            const source = resolve(import.meta.dirname, 'fixtures/media', format, 'media.m3u8');
            const hashes = (file: string) =>
              execFileSync(
                'ffmpeg',
                ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'],
                { encoding: 'utf8' },
              )
                .split('\n')
                .filter((l) => l && !l.startsWith('#'))
                .map((l) => l.split(',').at(-1)?.trim());
            if (
              process.env.HLS_KEYED_DIAGNOSTIC &&
              format === 'hevc-ts' &&
              !audio &&
              mode === 'download'
            )
              writeFileSync(process.env.HLS_KEYED_DIAGNOSTIC, bytes);
            expect(hashes(output)).toEqual(hashes(source));
            const pcm = execFileSync('ffmpeg', [
              '-v',
              'error',
              '-i',
              output,
              '-map',
              '0:a:0',
              '-ac',
              '1',
              '-ar',
              '48000',
              '-f',
              's16le',
              '-',
            ]);
            const samples = new Int16Array(
              pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length),
            );
            let crossings = 0;
            for (let i = 1; i < samples.length; i++)
              if (samples[i - 1]! <= 0 && samples[i]! > 0) crossings++;
            const frequency = crossings / (samples.length / 48000);
            expect(frequency).toBeGreaterThan(audio ? 800 : 400);
            expect(frequency).toBeLessThan(audio ? 960 : 500);
            expect(requests.some((r) => r.originalSequence === sequence.toString())).toBe(true);
            expect(requests.every((r) => r.operationId && r.signal instanceof AbortSignal)).toBe(
              true,
            );
            expect(progress.at(-1).decryption.inputs[0].committed).toBe('2');
            expect(progress.at(-1).decryption.inputs[0].media.decryptedResources).toBe('1');
            expect(server.requests.some((r) => r.path === '/key')).toBe(false);
          });
        }
    // Required timeline regression: https://github.com/Logosww/hls-transmux/issues/2
    for (const format of ['ts', 'fmp4'])
      for (const mode of ['download', 'stream', 'writable'])
        it(`${format} offset external audio ${mode} preserves presentation duration`, async () => {
          const server = await startFixtureServer(encryptedRoutes(format, true, true, false));
          servers.push(server);
          const d = new HlsDownloader({ adapter });
          const options = { url: server.origin + '/master.m3u8', filename: path() };
          let bytes: Uint8Array;
          if (mode === 'download') {
            const result = await d.download(options);
            if ('blobURL' in result) {
              bytes = new Uint8Array(await (await fetch(result.blobURL)).arrayBuffer());
              URL.revokeObjectURL(result.blobURL);
            } else {
              paths.push(result.filePath);
              bytes = readFileSync(result.filePath);
            }
          } else {
            const chunks: Uint8Array[] = [];
            if (mode === 'stream')
              await d.downloadToStream(options, (b) => {
                chunks.push(b);
              });
            else
              await d.downloadToWritable(
                options,
                new WritableStream({
                  write(b) {
                    chunks.push(b);
                  },
                }),
              );
            bytes = Buffer.concat(chunks);
          }
          const output = path();
          writeFileSync(output, bytes);
          const probe = JSON.parse(
            execFileSync(
              'ffprobe',
              ['-v', 'error', '-show_packets', '-show_format', '-of', 'json', output],
              { encoding: 'utf8' },
            ),
          );
          const end = Math.max(
            ...probe.packets.map((p: any) => Number(p.pts_time) + Number(p.duration_time)),
          );
          const starts = [0, 1].map((index) =>
            Math.min(
              ...probe.packets
                .filter((p: any) => p.stream_index === index)
                .map((p: any) => Number(p.pts_time)),
            ),
          );
          expect(Math.abs(starts[0]! - starts[1]!)).toBeGreaterThan(1.3);
          expect(end).toBeGreaterThan(3.3);
          expect(end).toBeLessThan(3.5);
          expect(Math.abs(Number(probe.format.duration) - end)).toBeLessThan(0.05);
        });
    it('uses the default HTTP provider and preserves headers', async () => {
      const server = await fixture();
      const d = new HlsDownloader({ adapter });
      await d.downloadToStream(
        { url: server.origin + '/video/media.m3u8', headers: { authorization: 'Bearer test' } },
        () => {},
      );
      expect(server.requests.filter((r) => r.path === '/key').length).toBeGreaterThan(0);
      expect(server.requests.every((r) => r.headers.authorization === 'Bearer test')).toBe(true);
    });
    it.each([
      ['unavailable', async () => null, 'KEY_UNAVAILABLE'],
      [
        'throw',
        async () => {
          throw new Error('secret-provider-message');
        },
        'KEY_RESOLUTION_FAILED',
      ],
      ['short', async () => ({ key: new Uint8Array(15) }), 'KEY_INVALID'],
      ['expired', async () => ({ key, expiresInMs: 0 }), 'KEY_EXPIRED'],
    ] as const)('%s resolver is typed and redacted', async (_, resolver, code) => {
      const server = await fixture();
      const d = new HlsDownloader({ adapter });
      const error = await d
        .downloadToStream(
          {
            url: server.origin + '/video/media.m3u8',
            decryption: { keyResolver: resolver as HlsKeyResolver },
          },
          () => {},
        )
        .catch((e) => e);
      expect(error.code).toBe(code);
      expect(JSON.stringify(error)).not.toContain('secret-provider-message');
      expect(String(error)).not.toContain('secret-provider-message');
      expect(server.requests.some((r) => r.path === '/key')).toBe(false);
    });
    it.each(['truncated', 'padding', 'media'] as const)(
      'maps %s ciphertext failures without output or retry',
      async (scenario) => {
        const body = encrypt(new Uint8Array(188 * 3), 0n);
        if (scenario === 'padding') body[body.length - 17]! ^= 4; // Turn the final 0x0c padding byte into 0x08 only.
        const server = await startFixtureServer({
          '/media.m3u8': (_, res) =>
            sendText(
              res,
              '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST',
            ),
          '/key': (_, res) => sendBytes(res, key),
          '/segment.ts': (_, res) =>
            sendBytes(res, scenario === 'truncated' ? body.subarray(0, body.length - 1) : body),
        });
        servers.push(server);
        let writes = 0;
        const error = await new HlsDownloader({ adapter })
          .downloadToStream({ url: server.origin + '/media.m3u8', maxRetry: 3 }, () => {
            writes++;
          })
          .catch((e) => e);
        expect(error.code).toBe(scenario === 'media' ? 'MEDIA_INVALID' : 'DECRYPT_FAILED');
        expect(writes).toBe(0);
        expect(server.attempts.get('/segment.ts')).toBe(1);
      },
    );
    it('rejects future unsupported tags before media and key IO', async () => {
      const routes = encryptedRoutes();
      routes['/invalid.m3u8'] = (_, res) =>
        sendText(
          res,
          '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:1,\nvideo/segment-00.ts\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="/key"\n#EXTINF:1,\nvideo/segment-01.ts\n#EXT-X-ENDLIST\n',
        );
      const server = await startFixtureServer(routes);
      servers.push(server);
      await expect(
        new HlsDownloader({ adapter }).downloadToStream(
          { url: server.origin + '/invalid.m3u8' },
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCRYPTION' });
      expect(server.requests).toHaveLength(1);
    });
    it('cancels a noncooperative resolver and observes its late rejection', async () => {
      const server = await fixture();
      const d = new HlsDownloader({ adapter });
      const controller = new AbortController();
      let called!: () => void;
      const started = new Promise<void>((r) => (called = r));
      let late!: (e: Error) => void;
      let signal!: AbortSignal;
      const task = d.downloadToStream(
        {
          url: server.origin + '/video/media.m3u8',
          signal: controller.signal,
          decryption: {
            keyResolver: (r) => {
              signal = r.signal;
              called();
              return new Promise((_, reject) => (late = reject));
            },
          },
        },
        () => {},
      );
      await started;
      controller.abort();
      await expect(task).rejects.toMatchObject({ code: 'ABORTED' });
      expect(signal.aborted).toBe(true);
      late(new Error('late secret'));
      await new Promise((r) => setTimeout(r, 10));
    });
    it.each(['write', 'close'])('preserves %s failure and suppresses completion', async (phase) => {
      const server = await fixture();
      const events: string[] = [];
      const cause = new Error('sink failed');
      const d = new HlsDownloader({ adapter, onEvent: (e) => events.push(e) });
      const sink = new WritableStream({
        write() {
          if (phase === 'write') throw cause;
        },
        close() {
          if (phase === 'close') throw cause;
        },
      });
      await expect(
        d.downloadToWritable({ url: server.origin + '/video/media.m3u8' }, sink),
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
      expect(events).not.toContain('ready-for-download');
      expect(sink.locked).toBe(false);
    });
    it('enforces the media byte cap during JS reads', async () => {
      const server = await fixture();
      await expect(
        new HlsDownloader({ adapter }).downloadToStream(
          {
            url: server.origin + '/video/media.m3u8',
            decryption: { limits: { resourceBytes: 32 } },
          },
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    });
    it('enforces the manifest cap before resource IO', async () => {
      const server = await fixture();
      await expect(
        new HlsDownloader({ adapter }).downloadToStream(
          {
            url: server.origin + '/video/media.m3u8',
            decryption: { limits: { manifestBytes: 32 } },
          },
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
      expect(server.requests).toHaveLength(1);
    });
    it('requires encrypted range attestation and exact large decimal ranges', async () => {
      const offset = 9007199254740993n;
      const body = encrypt(
        readFileSync(resolve(import.meta.dirname, 'fixtures/media/ts/segment-00.ts')),
        5n,
      );
      const routes = encryptedRoutes();
      routes['/range.m3u8'] = (_, res) =>
        sendText(
          res,
          `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:5\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:1,\n#EXT-X-BYTERANGE:${body.length}@${offset}\n/range.ts\n#EXT-X-ENDLIST\n`,
        );
      routes['/range.ts'] = (req, res) => {
        expect(req.headers.range).toBe(`bytes=${offset}-${offset + BigInt(body.length) - 1n}`);
        res.writeHead(206, {
          'content-range': `bytes ${offset}-${offset + BigInt(body.length) - 1n}/*`,
        });
        res.end(body);
      };
      const server = await startFixtureServer(routes);
      servers.push(server);
      const d = new HlsDownloader({ adapter });
      const options = { url: server.origin + '/range.m3u8' };
      await expect(d.downloadToStream(options, () => {})).rejects.toMatchObject({
        code: 'UNSUPPORTED_ENCRYPTION',
      });
      expect(server.requests).toHaveLength(1);
      const r = await d.downloadToStream(
        { ...options, decryption: { encryptedRanges: 'complete-resources' } },
        () => {},
      );
      expect(r.totalSegments).toBe(1);
    });
    it('does not share provider results across operations with identical public IDs', async () => {
      const server = await fixture();
      const d = new HlsDownloader({ adapter });
      let first = 0;
      let second = 0;
      const options = { url: server.origin + '/video/media.m3u8', operationId: 'same' };
      const results = await Promise.allSettled([
        d.downloadToStream(
          {
            ...options,
            decryption: {
              keyResolver: async () => {
                first++;
                return { key };
              },
            },
          },
          () => {},
        ),
        d.downloadToStream(
          {
            ...options,
            decryption: {
              keyResolver: async () => {
                second++;
                return null;
              },
            },
          },
          () => {},
        ),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(0);
    });
    it('tries a second key format only after unavailable', async () => {
      const routes = encryptedRoutes();
      routes['/formats.m3u8'] = (_, res) =>
        sendText(
          res,
          `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-KEY:METHOD=AES-128,URI="/private-key",KEYFORMAT="custom"\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:1,\nvideo/segment-00.ts\n#EXT-X-ENDLIST\n`,
        );
      const server = await startFixtureServer(routes);
      servers.push(server);
      const calls: string[] = [];
      await new HlsDownloader({ adapter }).downloadToStream(
        {
          url: server.origin + '/formats.m3u8',
          decryption: {
            keyFormats: [
              { format: 'custom', versions: [1] },
              { format: 'identity', versions: [1] },
            ],
            keyResolver: async (r) => {
              calls.push(r.keyFormat);
              return r.keyFormat === 'custom' ? null : { key };
            },
          },
        },
        () => {},
      );
      expect(calls).toEqual(['custom', 'identity']);
    });

    it('rotates key bytes at a new declaration using the same URI', async () => {
      const second = new Uint8Array(16).fill(42);
      const routes = encryptedRoutes();
      const media =
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:500\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:1,\nfirst.ts\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:1,\nsecond.ts\n#EXT-X-ENDLIST\n';
      routes['/rotate.m3u8'] = (_, res) => sendText(res, media);
      routes['/first.ts'] = (_, res) =>
        sendBytes(
          res,
          encrypt(
            readFileSync(resolve(import.meta.dirname, 'fixtures/media/ts/segment-00.ts')),
            500n,
          ),
        );
      routes['/second.ts'] = (_, res) =>
        sendBytes(
          res,
          encrypt(
            readFileSync(resolve(import.meta.dirname, 'fixtures/media/ts/segment-01.ts')),
            501n,
            Buffer.from(second),
          ),
        );
      const server = await startFixtureServer(routes);
      servers.push(server);
      const declarations = new Set<string>();
      await new HlsDownloader({ adapter }).downloadToStream(
        {
          url: server.origin + '/rotate.m3u8',
          decryption: {
            keyResolver: async (r) => {
              declarations.add(r.declaration.ordinal);
              return { key: r.originalSequence === '500' ? key : second };
            },
          },
        },
        () => {},
      );
      expect(declarations.size).toBe(2);
    });
    it.each([401, 429, 15, 17])(
      'handles HTTP key response %s with one retry policy',
      async (status) => {
        const routes = encryptedRoutes();
        routes['/key'] = (req, res) => {
          if (status === 401 || (status === 429 && req.attempt === 1)) {
            res.writeHead(status).end();
            return;
          }
          return sendBytes(res, status === 15 || status === 17 ? new Uint8Array(status) : key);
        };
        const server = await startFixtureServer(routes);
        servers.push(server);
        const task = new HlsDownloader({ adapter }).downloadToStream(
          { url: server.origin + '/video/media.m3u8', maxRetry: 2 },
          () => {},
        );
        if (status === 429) {
          await task;
          expect(server.attempts.get('/key')).toBeGreaterThanOrEqual(2);
        } else {
          await expect(task).rejects.toMatchObject({
            code: status === 401 ? 'KEY_RESOLUTION_FAILED' : 'KEY_INVALID',
          });
          expect(server.attempts.get('/key')).toBe(1);
        }
      },
    );
    it('preflights the whole external-audio playlist before key or media IO', async () => {
      const routes = encryptedRoutes('ts', true);
      routes['/audio/media.m3u8'] = (_, res) =>
        sendText(
          res,
          '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:1,\na.ts\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="/key"\n#EXTINF:1,\nb.ts\n#EXT-X-ENDLIST\n',
        );
      const server = await startFixtureServer(routes);
      servers.push(server);
      await expect(
        new HlsDownloader({ adapter }).downloadToStream(
          { url: server.origin + '/master.m3u8' },
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCRYPTION' });
      expect(server.requests.every((r) => r.path.endsWith('.m3u8'))).toBe(true);
    });
    it.each(['EVENT', 'discontinuity', 'GCM', 'open'])(
      'rejects unsupported keyed %s before resource IO',
      async (scenario) => {
        const routes = encryptedRoutes();
        const tag =
          scenario === 'EVENT'
            ? '#EXT-X-PLAYLIST-TYPE:EVENT\n'
            : scenario === 'discontinuity'
              ? '#EXT-X-DISCONTINUITY\n'
              : '';
        routes['/unsupported.m3u8'] = (_, res) =>
          sendText(
            res,
            `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=${scenario === 'GCM' ? 'AES-128-GCM' : 'AES-128'},URI="/key"\n${tag}#EXTINF:1,\nx.ts\n${scenario === 'open' ? '' : '#EXT-X-ENDLIST\n'}`,
          );
        const server = await startFixtureServer(routes);
        servers.push(server);
        await expect(
          new HlsDownloader({ adapter }).downloadToStream(
            { url: server.origin + '/unsupported.m3u8' },
            () => {},
          ),
        ).rejects.toMatchObject({
          code: scenario === 'GCM' ? 'UNSUPPORTED_ENCRYPTION' : 'TRANSMUX_FAILED',
        });
        expect(server.requests).toHaveLength(1);
      },
    );
    for (const explicit of [false, true])
      for (const mode of ['download', 'stream'])
        it(`rejects encrypted ${mode} transcoding with ${explicit ? 'explicit' : 'automatic'} decryption`, async () => {
          const server = await fixture();
          const d = new HlsDownloader({ adapter });
          const options = {
            url: server.origin + '/video/media.m3u8',
            transcode: { preset: 'h264' as const },
            ...(explicit ? { decryption: {} } : {}),
          };
          let error: any;
          try {
            if (mode === 'download') await d.download(options);
            else
              await d.downloadToStream(options, () => {
                throw new Error('unexpected output');
              });
          } catch (e) {
            error = e;
          }
          expect(['UNSUPPORTED_OUTPUT', 'UNSUPPORTED_ENCRYPTION']).toContain(error?.code);
          expect(server.requests.every((r) => r.path.endsWith('.m3u8'))).toBe(true);
        });
    if (name === 'node')
      for (const explicit of [false, true])
        for (const combination of ['resume', 'aria2'])
          it(`rejects encrypted ${combination} with ${explicit ? 'explicit' : 'automatic'} decryption`, async () => {
            const server = await fixture();
            const d = new HlsDownloader({ adapter: NodeAdapter });
            const options = {
              url: server.origin + '/video/media.m3u8',
              ...(explicit ? { decryption: {} } : {}),
              ...(combination === 'resume'
                ? { resume: { directory: path() } }
                : { aria2: { enabled: true } }),
            };
            let error: any;
            try {
              await d.download(options);
            } catch (e) {
              error = e;
            }
            expect(['UNSUPPORTED_OUTPUT', 'UNSUPPORTED_ENCRYPTION']).toContain(error?.code);
            expect(server.requests.every((r) => r.path.endsWith('.m3u8'))).toBe(true);
          });
    it('rejects encrypted WebVTT before key or media requests', async () => {
      const server = await startFixtureServer({
        '/master.m3u8': (_, res) =>
          sendText(
            res,
            '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="en",URI="sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,SUBTITLES="s"\nvideo.m3u8\n',
          ),
        '/video.m3u8': (_, res) =>
          sendText(res, '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nvideo.ts\n#EXT-X-ENDLIST'),
        '/sub.m3u8': (_, res) =>
          sendText(
            res,
            '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\nsub.vtt\n#EXT-X-ENDLIST',
          ),
      });
      servers.push(server);
      await expect(
        new HlsDownloader({ adapter }).downloadSubtitles({
          url: server.origin + '/master.m3u8',
          subtitle: { groupId: 's', name: 'en' },
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCRYPTION' });
      expect(server.requests.every((r) => r.path.endsWith('.m3u8'))).toBe(true);
    });
    it('ignores global transcoding for keyed writable output', async () => {
      const server = await fixture();
      const d = new HlsDownloader({ adapter, options: { transcode: { preset: 'h264' } } });
      const result = await d.downloadToWritable(
        { url: server.origin + '/video/media.m3u8' },
        new WritableStream(),
      );
      expect(result.totalSegments).toBe(2);
    });
    it('parses large sequence and map keys without resource IO', async () => {
      const d = new HlsDownloader({ adapter });
      const p = await d.parseMediaPlaylist(
        `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\na.m4s\n#EXT-X-ENDLIST`,
        'https://example.test/list.m3u8',
      );
      expect(p.segments[0].originalSequence).toBe(sequence.toString());
      expect(p.segments[0].keys).toEqual([]);
      expect(p.segments[0].map!.keys[0].method).toBe('AES-128');
    });
  });
}
