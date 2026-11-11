import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { startFixtureServer, sendBytes, sendText } from './fixtures/http-server';
import { shiftTsTimestamps } from './fixtures/continuous-ts';
const dir = mkdtempSync(join(tmpdir(), 'aac-retry-'));
const media = (s: string) => readFileSync(resolve(import.meta.dirname, 'fixtures/media/ts', s));
const outputs: string[] = [];
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
  rmSync(dir, { recursive: true, force: true });
  for (const p of outputs) rmSync(p, { force: true });
});
function shiftAudio(input: Buffer, ms: number) {
  const shifted = shiftTsTimestamps(input, -ms / 1000),
    out = Buffer.from(input);
  for (let p = 0; p + 188 <= input.length; p += 188) {
    if (!(input[p + 1]! & 0x40)) continue;
    const c = (input[p + 3]! >> 4) & 3;
    if (!(c & 1)) continue;
    const pes = p + 4 + (c & 2 ? 1 + input[p + 4]! : 0);
    if (
      pes + 9 < p + 188 &&
      input[pes] === 0 &&
      input[pes + 1] === 0 &&
      input[pes + 2] === 1 &&
      input[pes + 3]! >= 0xc0 &&
      input[pes + 3]! <= 0xdf
    )
      out.set(shifted.subarray(p, p + 188), p);
  }
  return out;
}
let serial = 0;
for (const [name, adapter] of [
  ['node', NodeAdapter],
  ['wasm', BrowserAdapter],
] as const) {
  describe(name, () => {
    let cleanAudio: string;
    let cleanVideo: string;
    for (const c of [
      { name: 'stream stays strict', shift: 30, stream: true, expected: 'overlap' },
      { name: 'clean stays strict', shift: 0, expected: 'strict' },
      { name: 'default repairs and reuses segments', shift: 30, expected: 'repair' },
      {
        name: 'rotating master session reuses the original selection',
        shift: 30,
        rotating: true,
        expected: 'repair',
      },
      {
        name: 'disabled returns overlap details',
        shift: 30,
        repair: false as const,
        expected: 'overlap',
      },
      { name: 'default limit rejects large overlap', shift: 80, expected: 'limit' },
      {
        name: 'caller can raise limit',
        shift: 80,
        repair: { maxShiftMs: 100 },
        expected: 'repair',
      },
      { name: 'caller can lower limit', shift: 30, repair: { maxShiftMs: 1 }, expected: 'limit' },
      {
        name: 'cache exhaustion preserves strict error',
        shift: 30,
        repair: { maxCacheBytes: 1 },
        expected: 'overlap',
      },
    ])
      it(c.name, async () => {
        const counts = [0, 0];
        let manifests = 0;
        let masters = 0;
        const server = await startFixtureServer({
          '/master.m3u8': (_, res) =>
            sendText(
              res,
              `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nmedia.m3u8?session=${++masters}\n`,
            ),
          '/media.m3u8': (_, res) => {
            manifests++;
            sendText(res, media('media.m3u8').toString());
          },
          '/segment-00.ts': (_, res) => {
            counts[0]++;
            sendBytes(res, media('segment-00.ts'));
          },
          '/segment-01.ts': (_, res) => {
            counts[1]++;
            sendBytes(res, shiftAudio(media('segment-01.ts'), c.shift));
          },
        });
        try {
          const d = new HlsDownloader({ adapter });
          const filename = resolve(`${basename(dir)}-${serial++}.mp4`);
          outputs.push(filename);
          const options = {
            url: server.origin + (c.rotating ? '/master.m3u8' : '/media.m3u8'),
            filename,
            timeline: { aacOverlapRepair: c.repair },
          };
          const pending = c.stream
            ? d.downloadToWritable(options, new WritableStream({ write() {} }))
            : d.download(options);
          if (c.expected === 'overlap' || c.expected === 'limit') {
            const e = await pending.catch((e) => e);
            expect(e).toMatchObject({
              code: 'TIMELINE_FAILED',
              reason:
                c.expected === 'overlap'
                  ? 'AacTimestampOverlap'
                  : 'AacTimestampRepairLimitExceeded',
            });
            if (c.expected === 'overlap') expect(e.aacOverlap.overlap.ticks).toBeDefined();
            else
              expect(e.aacRepair.maxShiftMs).toBe(
                c.repair && 'maxShiftMs' in c.repair ? c.repair.maxShiftMs : 50,
              );
          } else {
            const result = (await pending) as Awaited<ReturnType<typeof d.download>>;
            if (c.expected === 'strict') expect(result.report?.aacRepairs).toBeUndefined();
            else expect(BigInt(result.report!.aacRepairs![0]!.correctedFrames)).toBeGreaterThan(0n);
            const path = join(dir, 'verify.mp4');
            writeFileSync(
              path,
              'blobURL' in result
                ? Buffer.from(await (await fetch(result.blobURL)).arrayBuffer())
                : readFileSync(result.filePath),
            );
            const audio = createHash('sha256')
              .update(
                execFileSync('ffmpeg', [
                  '-v',
                  'error',
                  '-xerror',
                  '-i',
                  path,
                  '-map',
                  '0:a:0',
                  '-f',
                  's16le',
                  '-',
                ]),
              )
              .digest('hex');
            const video = createHash('sha256')
              .update(
                execFileSync(
                  'ffmpeg',
                  ['-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-f', 'rawvideo', '-'],
                  { maxBuffer: 32 * 1024 * 1024 },
                ),
              )
              .digest('hex');
            if (c.expected === 'strict') {
              cleanAudio = audio;
              cleanVideo = video;
            } else {
              expect(audio).toBe(cleanAudio);
              expect(video).toBe(cleanVideo);
            }
            if ('blobURL' in result) URL.revokeObjectURL(result.blobURL);
          }
          expect(counts).toEqual([1, 1]);
          if (c.rotating) {
            expect(masters).toBe(1);
            expect(manifests).toBe(1);
          }
        } finally {
          await server.close();
        }
      });
  });
}
