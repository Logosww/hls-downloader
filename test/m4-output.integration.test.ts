import { afterAll, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { m4Profiles } from './fixtures/m4';
import { startFixtureServer, type FixtureHandler } from './fixtures/http-server';
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
const directory = mkdtempSync(join(tmpdir(), 'm4-output-'));
afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
});
function decoded(bytes: Uint8Array) {
  const path = join(directory, 'output.mp4');
  writeFileSync(path, bytes);
  return execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-xerror',
      '-i',
      path,
      '-map',
      '0',
      '-fps_mode',
      'passthrough',
      '-f',
      'framemd5',
      '-',
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => s.split(',').map((s) => s.trim()));
}
function openRoutes(routes: Record<string, FixtureHandler>, event: boolean) {
  return Object.fromEntries(
    Object.entries(routes).map(([path, handler]) => [
      path,
      (req: any, res: any) => {
        if (path.endsWith('.m3u8')) {
          const end = res.end.bind(res);
          res.end = (data: any) => {
            let text = String(data);
            if (text.includes('#EXTINF'))
              text = text
                .replace(/^#EXT-X-ENDLIST.*\n?/gm, '')
                .replace(/^#EXT-X-PLAYLIST-TYPE.*\n?/gm, '')
                .replace('#EXTM3U', '#EXTM3U' + (event ? '\n#EXT-X-PLAYLIST-TYPE:EVENT' : ''));
            return end(text);
          };
        }
        return handler(req, res);
      },
    ]),
  ) as Record<string, FixtureHandler>;
}
for (const profile of m4Profiles)
  for (const mode of ['finite', 'live', 'event'] as const)
    it(`${profile.name}: ${mode} native/WASM selected writable parity`, async () => {
      const routes = profile.routes();
      const server = await startFixtureServer(
        mode === 'finite' ? routes : openRoutes(routes, mode === 'event'),
      );
      try {
        const results = [];
        for (const adapter of [NodeAdapter, BrowserAdapter]) {
          const dl = new HlsDownloader({ adapter }),
            chunks: Uint8Array[] = [];
          let closed = false,
            writes = 0;
          const writable = new WritableStream<Uint8Array>({
            async write(b) {
              await new Promise((r) => setTimeout(r, 1));
              chunks.push(b.slice());
              writes++;
            },
            close() {
              closed = true;
            },
          });
          const options = { ...profile.options, url: server.origin + profile.url };
          let report;
          if (mode === 'finite') {
            report = (await dl.downloadToWritable(options, writable)).report;
            const stream: Uint8Array[] = [];
            await dl.downloadToStream(options, (b) => stream.push(b.slice()));
            expect(decoded(Buffer.concat(stream))).toEqual(decoded(Buffer.concat(chunks)));
          } else {
            // Keep the same selected inputs, but remove finite range so explicit stop is exercised.
            const session = dl.startRecording({
              ...options,
              timeline: undefined,
              output: { type: 'writable', writable },
              onEvent(e: any) {
                if (e.type === 'progress') session.stop();
              },
            });
            report = (await session.result).report;
            expect(report.endReason).toBe('Stop');
            expect(report.inputs.every((i: any) => i.accepted === i.committed)).toBe(true);
          }
          expect(closed).toBe(true);
          expect(writes).toBeGreaterThan(0);
          results.push(decoded(Buffer.concat(chunks)));
        }
        expect(results[0].length).toBeGreaterThan(0);
        expect(results[0]).toEqual(results[1]);
      } finally {
        await server.close();
      }
    });
