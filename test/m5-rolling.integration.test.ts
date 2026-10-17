import { afterAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { startSource } from './m5/source';
import { record } from './m5/record';

const originalFetch = globalThis.fetch;
globalThis.fetch = ((input, init) =>
  String(input).startsWith('file:') && String(input).endsWith('.wasm')
    ? Promise.resolve(
        new Response(
          readFileSync(
            new URL(
              '../packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
              import.meta.url,
            ),
          ),
          { headers: { 'content-type': 'application/wasm' } },
        ),
      )
    : originalFetch(input, init)) as typeof fetch;
afterAll(() => (globalThis.fetch = originalFetch));

for (const [name, adapter] of [
  ['native', NodeAdapter],
  ['wasm', BrowserAdapter],
] as const) {
  it(`${name}: overlapping encrypted subtitle windows tolerate renumbered key declarations`, async () => {
    const source = await startSource(32);
    try {
      const result = await record(
        new HlsDownloader({ adapter }),
        source.origin + '/rolling/master.m3u8',
        32,
      );
      expect(result.subtitleCommits).toBe(32);
      expect(result.peakWrites).toBe(1);
      expect(result.report?.inputs[0]?.committed).toBe('32');
    } finally {
      await source.close();
    }
  });
  for (const rewrite of ['uri', 'iv'] as const)
    it(`${name}: overlapping subtitle key ${rewrite} changes still reject`, async () => {
      const source = await startSource(32, 16, rewrite);
      try {
        await expect(
          record(new HlsDownloader({ adapter }), source.origin + '/rewrite/master.m3u8', 32),
        ).rejects.toMatchObject({ code: 'RESOURCE_CHANGED', inputId: 'captions' });
      } finally {
        await source.close();
      }
    });
}
