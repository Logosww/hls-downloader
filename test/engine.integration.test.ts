import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { exportChapters } from '../packages/shared/src/index';
import { startFixtureServer, sendText, sendBytes } from './fixtures/http-server';
import { shiftTsTimestamps } from './fixtures/continuous-ts';
const dir = mkdtempSync(join(tmpdir(), 'hls-engine-sdk-'));
const media = (name: string) => readFileSync(resolve(import.meta.dirname, 'fixtures/media', name));
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
const files: string[] = [];
afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    rmSync(f, { force: true });
    rmSync(f + '.hls-partial', { force: true });
  }
});
const output = () => {
  const p = resolve(`${basename(dir)}-${serial++}.mp4`);
  files.push(p);
  return p;
};
let serial = 0;
async function fixture(gcm = false, tamper = false, modify = (text: string) => text) {
  const key = Buffer.alloc(32, 7),
    iv = Buffer.alloc(16, 3);
  let fail = false;
  const encrypt = (b: Buffer) => {
    const c = createCipheriv('aes-256-gcm', key, iv);
    const out = Buffer.concat([iv, c.update(b), c.final(), c.getAuthTag()]);
    if (tamper) out[out.length - 1] ^= 1;
    return out;
  };
  const source = media('ts/media.m3u8').toString();
  const playlist = gcm
    ? source.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-256-GCM,URI="key"')
    : source;
  const server = await startFixtureServer({
    '/media.m3u8': (_, res) => sendText(res, modify(playlist)),
    '/key': (_, res) => sendBytes(res, key),
    '/segment-00.ts': (_, res) =>
      sendBytes(res, gcm ? encrypt(media('ts/segment-00.ts')) : media('ts/segment-00.ts')),
    '/segment-01.ts': (_, res) =>
      fail
        ? res.writeHead(503).end()
        : sendBytes(res, gcm ? encrypt(media('ts/segment-01.ts')) : media('ts/segment-01.ts')),
  });
  return {
    ...server,
    key,
    url: server.origin + '/media.m3u8',
    fail: (v: boolean) => {
      fail = v;
    },
  };
}
for (const [name, adapter] of [
  ['node', NodeAdapter],
  ['browser', BrowserAdapter],
] as const) {
  describe(name, () => {
    it('downloads VOD beyond the recording queue default and honors explicit queue limits', async () => {
      const count = 130;
      const f = await startFixtureServer({
        '/media.m3u8': (_, res) =>
          sendText(
            res,
            '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' +
              Array.from({ length: count }, (_, i) => `#EXTINF:2,\nsegment.ts?i=${i}\n`).join('') +
              '#EXT-X-ENDLIST\n',
          ),
        '/segment.ts': (req, res) =>
          sendBytes(
            res,
            shiftTsTimestamps(media('ts/segment-00.ts'), Number(req.query.get('i')) * 2),
          ),
      });
      try {
        const downloader = new HlsDownloader({ adapter });
        const url = f.origin + '/media.m3u8';
        let bytes = 0;
        const result = await downloader.downloadToWritable(
          { url },
          new WritableStream<Uint8Array>({
            write(chunk) {
              bytes += chunk.length;
            },
          }),
        );
        expect(result.totalSegments).toBe(count);
        expect(bytes).toBeGreaterThan(0);
        await expect(
          downloader.downloadMultiTrack({
            url,
            embeddedAudio: 'keep',
            limits: { queuedDescriptors: 128 },
            output: { type: 'writable', writable: new WritableStream() },
          }),
        ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED', reason: 'QueueLimit' });
        await expect(
          downloader.downloadMultiTrack({
            url,
            embeddedAudio: 'keep',
            limits: { queuedMetadataBytes: 64 },
            output: { type: 'writable', writable: new WritableStream() },
          }),
        ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
      } finally {
        await f.close();
      }
    });

    it('finite downloads use Engine reports and exact sidecar mappings', async () => {
      const f = await fixture();
      try {
        const result = await new HlsDownloader({ adapter }).download({
          url: f.url,
          filename: output(),
        });
        expect(result.report?.tracks.length).toBeGreaterThan(0);
        expect(result.report?.timelineMap?.complete).toBe(true);
        expect(result).not.toHaveProperty('timelineReport');
        const map = result.report!.timelineMap!;
        const chapters = exportChapters({
          timelineMap: map,
          chapters: [{ range: map.outputs[0]!.actualRange, title: 'Chapter' }],
        });
        expect(chapters[0]!.text).toContain('Chapter');
        const file = 'filePath' in result ? result.filePath : join(dir, `blob-${serial++}.mp4`);
        if ('blobURL' in result) {
          writeFileSync(file, Buffer.from(await (await fetch(result.blobURL)).arrayBuffer()));
          URL.revokeObjectURL(result.blobURL);
        }
        execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], {
          stdio: 'pipe',
        });
      } finally {
        await f.close();
      }
    });
    it('rejects derived exports when mapping history is truncated', async () => {
      const f = await fixture();
      try {
        const r = await new HlsDownloader({ adapter }).downloadMultiTrack({
          url: f.url,
          embeddedAudio: 'keep',
          limits: { historyEntries: 1 },
          output: { type: 'writable', writable: new WritableStream() },
        });
        expect(r.report.timelineMap?.complete).toBe(false);
        expect(() =>
          exportChapters({ timelineMap: r.report.timelineMap!, chapters: [] }),
        ).toThrow();
      } finally {
        await f.close();
      }
    });
    it('GCM requires opt-in, authenticates media and rejects tampered tags', async () => {
      const f = await fixture(true);
      try {
        const dl = new HlsDownloader({ adapter });
        const opts = { url: f.url, filename: output(), maxRetry: 0 };
        await expect(dl.download(opts)).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCRYPTION' });
        const result = await dl.download({ ...opts, decryption: { experimentalGcm: true } });
        expect(result.report?.inputs[0]?.committed).toBe('2');
        if ('blobURL' in result) URL.revokeObjectURL(result.blobURL);
      } finally {
        await f.close();
      }
      const bad = await fixture(true, true);
      try {
        await expect(
          new HlsDownloader({ adapter }).download({
            url: bad.url,
            filename: output(),
            decryption: { experimentalGcm: true },
          }),
        ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
      } finally {
        await bad.close();
      }
    });
    it('GCM rejects invalid key length, explicit IV and unconfirmed byte ranges before output', async () => {
      for (const kind of ['key', 'iv', 'range', 'tag'] as const) {
        const f = await fixture(true, kind === 'tag', (text) =>
          kind === 'iv'
            ? text.replace('URI="key"', 'URI="key",IV=0x01')
            : kind === 'range'
              ? text.replace('segment-00.ts', '#EXT-X-BYTERANGE:64@0\nsegment-00.ts')
              : text,
        );
        let written = 0;
        try {
          const error = await new HlsDownloader({ adapter })
            .downloadToWritable(
              {
                url: f.url,
                maxRetry: 0,
                decryption: {
                  experimentalGcm: true,
                  ...(kind === 'key'
                    ? { keyResolver: async () => ({ key: new Uint8Array(16) }) }
                    : {}),
                },
              },
              new WritableStream({
                write(b) {
                  written += b.length;
                },
              }),
            )
            .catch((e) => e);
          expect(error.code, kind).toBe(
            kind === 'tag'
              ? 'AUTHENTICATION_FAILED'
              : kind === 'key'
                ? 'KEY_INVALID'
                : kind === 'iv'
                  ? 'MANIFEST_INVALID'
                  : 'UNSUPPORTED_ENCRYPTION',
          );
          expect(written).toBe(0);
        } finally {
          await f.close();
        }
      }
    });
    it('capability query separates playback from container and gates GCM/recovery', async () => {
      const dl = new HlsDownloader({ adapter });
      const query = {
        inputs: [
          {
            id: 'primary',
            container: 'ts' as const,
            encryption: 'AES-256-GCM' as const,
            codecs: ['avc' as const, 'aac-lc' as const],
          },
        ],
        output: 'writable' as const,
      };
      expect((await dl.queryCapability(query)).supported).toBe(false);
      expect((await dl.queryCapability({ ...query, experimentalGcm: true })).supported).toBe(true);
      expect(
        (await dl.queryCapability({ ...query, experimentalGcm: true, resume: true })).supported,
      ).toBe(false);
    });
  });
}
it('browser enforces collection capacity', async () => {
  const f = await fixture();
  try {
    await expect(
      new HlsDownloader({ adapter: BrowserAdapter }).download({ url: f.url, maxBytes: 32 }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
  } finally {
    await f.close();
  }
});
it('schema-2 completed recovery succeeds offline and does not overwrite unrelated output', async () => {
  const f = await fixture(),
    directory = join(dir, `resume-${serial++}`),
    filename = output();
  const dl = new HlsDownloader({ adapter: NodeAdapter });
  const opts = { url: f.url, filename, resume: { directory } };
  const result = await dl.download(opts);
  const before = readFileSync(result.filePath);
  expect(
    JSON.parse(readFileSync(join(directory, 'engine-state.json'), 'utf8')).checkpoint
      .schema_version,
  ).toBe(2);
  await f.close();
  const resumed = await dl.download(opts);
  expect(resumed.filePath).toBe(result.filePath);
  expect(readFileSync(result.filePath)).toEqual(before);
  writeFileSync(result.filePath, Buffer.from('unrelated'));
  await expect(dl.download(opts)).rejects.toMatchObject({ code: 'RESUME_INVALID' });
  expect(readFileSync(result.filePath, 'utf8')).toBe('unrelated');
});
it('schema-2 resumes a failed acquisition with replay identities intact', async () => {
  const f = await fixture(),
    directory = join(dir, `resume-${serial++}`),
    filename = output();
  const dl = new HlsDownloader({ adapter: NodeAdapter });
  const opts = { url: f.url, filename, resume: { directory }, maxRetry: 0 };
  try {
    f.fail(true);
    await expect(dl.download(opts)).rejects.toBeDefined();
    expect(existsSync(join(directory, 'engine-state.json'))).toBe(true);
    f.fail(false);
    const result = await dl.download(opts);
    expect(result.report?.inputs[0]?.committed).toBe('2');
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', result.filePath, '-f', 'null', '-'], {
      stdio: 'pipe',
    });
  } finally {
    await f.close();
  }
});
