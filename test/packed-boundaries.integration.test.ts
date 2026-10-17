import { afterAll, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { startFixtureServer, sendBytes, sendText } from './fixtures/http-server';
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
const directory = mkdtempSync(join(tmpdir(), 'packed-boundaries-'));
afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
});
const root = resolve(import.meta.dirname, 'fixtures/packed-aac/clear');
const media = [0, 1, 2, 3].map((i) => readFileSync(join(root, `seg${i}.bin`)));
const owner = Buffer.from('com.apple.streaming.transportStreamTimestamp\0');
const tagSize = (b: Buffer) => 10 + b.subarray(6, 10).reduce((n, v) => (n << 7) | v, 0);
for (const [runtime, adapter] of [
  ['native', NodeAdapter],
  ['wasm', BrowserAdapter],
] as const) {
  for (const kind of ['missing-id3', 'invalid-size', 'invalid-clock', 'wrap', 'offset'] as const)
    it(`${runtime} Packed AAC ${kind}`, async () => {
      const changed = media.map((b) => Buffer.from(b));
      if (kind === 'missing-id3') changed[0] = changed[0]!.subarray(tagSize(changed[0]!));
      else if (kind === 'invalid-size') changed[0]![6] = 0x80;
      else if (kind === 'invalid-clock')
        changed[0]!.writeBigUInt64BE(1n << 33n, changed[0]!.indexOf(owner) + owner.length);
      else
        for (const b of changed) {
          const offset = b.indexOf(owner) + owner.length;
          const shifted =
            (b.readBigUInt64BE(offset) + (kind === 'wrap' ? (1n << 33n) - 18000n : 900000n)) %
            (1n << 33n);
          b.writeBigUInt64BE(shifted, offset);
        }
      const server = await startFixtureServer({
        '/input.m3u8': (_, res) => sendText(res, readFileSync(join(root, 'input.m3u8'), 'utf8')),
        ...Object.fromEntries(
          changed.map((b, i) => [`/seg${i}.bin`, (_: any, res: any) => sendBytes(res, b)]),
        ),
      });
      try {
        const chunks: Uint8Array[] = [];
        let writes = 0;
        const pending = new HlsDownloader({ adapter }).downloadToWritable(
          { url: server.origin + '/input.m3u8' },
          new WritableStream({
            write(b) {
              chunks.push(b);
              writes++;
            },
          }),
        );
        if (kind.startsWith('invalid') || kind === 'missing-id3') {
          const error = await pending.catch((e) => e);
          expect(error.code).toBeDefined();
          expect([
            'MEDIA_INVALID',
            'RECORDING_FAILED',
            'MULTITRACK_FAILED',
            'TIMELINE_FAILED',
          ]).toContain(error.code);
          expect(writes).toBe(0);
        } else {
          const result = await pending;
          expect(result.report!.tracks[0]!.sampleCount).toBe('53');
          const path = join(directory, 'packed.mp4');
          writeFileSync(path, Buffer.concat(chunks));
          const probe = JSON.parse(
            execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-of', 'json', path], {
              encoding: 'utf8',
            }),
          );
          const times = probe.packets.map((p: any) => Number(p.dts_time));
          expect(times.length).toBe(53);
          expect(times).toEqual([...times].sort((a, b) => a - b));
          expect(times.at(-1) - times[0]).toBeCloseTo((52 * 1024) / 44100, 3);
          execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-']);
        }
      } finally {
        await server.close();
      }
    });
}
