import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { timelineCases, timelineRoutes, timelineOptions } from './fixtures/timeline';
import { startFixtureServer } from './fixtures/http-server';
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
const evidence: any[] = [];
const publishedFiles: string[] = [];
afterAll(() => {
  for (const path of publishedFiles) rmSync(path, { force: true });
});
afterAll(() => {
  mkdirSync(resolve(import.meta.dirname, '../test-results'), { recursive: true });
  writeFileSync(
    resolve(import.meta.dirname, '../test-results/timeline-wasm.json'),
    JSON.stringify(evidence, null, 2),
  );
});
const dir = mkdtempSync(resolve(tmpdir(), 'hls-timeline-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function canonical(bytes: Uint8Array): Buffer {
  const b = Buffer.from(bytes);
  const visit = (start: number, end: number) => {
    for (let i = start; i + 8 <= end;) {
      const size = b.readUInt32BE(i),
        kind = b.toString('ascii', i + 4, i + 8);
      if (size < 8 || i + size > end) throw Error('invalid MP4');
      if (['moov', 'trak', 'mdia'].includes(kind)) visit(i + 8, i + size);
      if (['mvhd', 'tkhd', 'mdhd'].includes(kind))
        b.fill(0, i + 12, i + (b[i + 8] === 1 ? 28 : 20));
      i += size;
    }
  };
  visit(0, b.length);
  return b;
}
for (const c of timelineCases)
  it(`native/WASM ${c.name}`, async () => {
    const server = await startFixtureServer(timelineRoutes(c));
    try {
      const results: any[] = [];
      for (const [name, adapter] of [
        ['browser', BrowserAdapter],
        ['node', NodeAdapter],
      ] as const) {
        const d = new HlsDownloader({ adapter });
        const options = {
          url: server.origin + '/master.m3u8',
          filename: resolve(dir, c.name + '-' + name),
          ...timelineOptions(c),
        };
        let report;
        const outputs: Uint8Array[] = [];
        const decoded: string[][] = [];
        if (c.request.mode === 'stream') {
          const chunks: Uint8Array[] = [];
          const result = await d.downloadToWritable(
            options,
            new WritableStream({
              write: (b) => {
                chunks.push(b);
              },
            }),
          );
          report = result.report;
          outputs.push(Buffer.concat(chunks));
        } else {
          const result = await d.downloadOutputs(options);
          report = result.report;
          for (const o of result.outputs) {
            if ('blobURL' in o) {
              outputs.push(new Uint8Array(await (await fetch(o.blobURL)).arrayBuffer()));
              URL.revokeObjectURL(o.blobURL);
            } else {
              publishedFiles.push(o.filePath);
              outputs.push(readFileSync(o.filePath));
            }
          }
        }
        expect(outputs).toHaveLength(c.outputs);
        expect(report?.schemaVersion).toBe(1);
        for (const [i, bytes] of outputs.entries()) {
          expect(bytes.length).toBeGreaterThan(100);
          const path = resolve(dir, `${c.name}-${name}-${i}-verify.mp4`);
          writeFileSync(path, bytes);
          const probe = JSON.parse(
            execFileSync(
              'ffprobe',
              ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
              { encoding: 'utf8' },
            ),
          );
          expect(probe.streams.length).toBeGreaterThan(0);
          execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], {
            stdio: 'pipe',
          });
          decoded.push(
            execFileSync(
              'ffmpeg',
              [
                '-v',
                'error',
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
              .filter((l) => l && !l.startsWith('#'))
              .map((l) => l.split(',').at(-1)!.trim()),
          );
        }
        results.push({ report, outputs: outputs.map(canonical), decoded });
      }
      // Historical prepared-session box hashes remain frozen in the fixture archive.
      // Streaming Engine output is checked by decoded samples and Native/WASM parity.
      evidence.push({
        name: c.name,
        report: results[0].report,
        hashes: results[0].outputs.map((b: Buffer) => createHash('sha256').update(b).digest('hex')),
      });
      expect(results[1].decoded).toEqual(results[0].decoded);
      expect(results[1].report.inputs).toEqual(results[0].report.inputs);
      expect(results[1].report.tracks).toEqual(results[0].report.tracks);
    } finally {
      await server.close();
    }
  });

for (const [name, adapter] of [
  ['browser', BrowserAdapter],
  ['node', NodeAdapter],
] as const)
  describe(`${name} timeline lifecycle`, () => {
    const split = timelineCases.find((c) => c.name === 'config-split');
    it('serializes split writes and completes after each close', async () => {
      const server = await startFixtureServer(timelineRoutes(split));
      const events: string[] = [];
      const chunks = new Map<string, Uint8Array[]>();
      try {
        const result = await new HlsDownloader({ adapter }).downloadToWritables(
          { url: server.origin + '/master.m3u8', ...timelineOptions(split) },
          async (output) => {
            events.push('acquire' + output.index);
            chunks.set(output.index, []);
            return new WritableStream({
              async write(b) {
                await new Promise((r) => setTimeout(r, 2));
                chunks.get(output.index)!.push(b);
              },
              async close() {
                await new Promise((r) => setTimeout(r, 5));
                events.push('close' + output.index);
              },
            });
          },
        );
        expect(result.report.outputs).toHaveLength(2);
        expect(events).toEqual(['acquire0', 'acquire1', 'close0', 'close1']);
        expect(chunks.get('0')!.length).toBeGreaterThan(0);
      } finally {
        await server.close();
      }
    });
    it.each(['write', 'close'])(
      'retains only publicly completed outputs on second %s failure',
      async (phase) => {
        const server = await startFixtureServer(timelineRoutes(split));
        const closed: string[] = [];
        try {
          const error = await new HlsDownloader({ adapter })
            .downloadToWritables(
              { url: server.origin + '/master.m3u8', ...timelineOptions(split) },
              async (o) =>
                new WritableStream({
                  write() {
                    if (o.index === '1' && phase === 'write') throw Error('sink-failed');
                  },
                  close() {
                    if (o.index === '1' && phase === 'close') throw Error('close-failed');
                    closed.push(o.index);
                  },
                }),
            )
            .catch((e) => e);
          expect(error.code).toBe('OUTPUT_WRITE_FAILED');
          expect(error.completedOutputs.map((o: any) => o.index)).toEqual(['0']);
          expect(closed).toEqual(['0']);
        } finally {
          await server.close();
        }
      },
    );
    it('does not close the preceding output when the next factory rejects', async () => {
      const server = await startFixtureServer(timelineRoutes(split));
      let closed = 0,
        aborted = 0;
      try {
        const error = await new HlsDownloader({ adapter })
          .downloadToWritables(
            { url: server.origin + '/master.m3u8', ...timelineOptions(split) },
            async (o) => {
              if (o.index === '1') throw Error('factory');
              return new WritableStream({
                close() {
                  closed++;
                },
                abort() {
                  aborted++;
                },
              });
            },
          )
          .catch((e) => e);
        expect(error.code).toBe('OUTPUT_WRITE_FAILED');
        expect(error.completedOutputs).toEqual([]);
        expect(closed).toBe(0);
        expect(aborted).toBe(1);
      } finally {
        await server.close();
      }
    });
    it('validates the sample planning budget before acquiring any sink', async () => {
      const server = await startFixtureServer(timelineRoutes(split));
      let acquired = 0;
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadToWritables(
            { url: server.origin + '/master.m3u8', timeline: { limits: { samples: 1 } } },
            async () => {
              acquired++;
              return new WritableStream();
            },
          ),
        ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
        expect(acquired).toBe(0);
      } finally {
        await server.close();
      }
    });
    it('cancels an unresolved output factory and aborts its late sink', async () => {
      const server = await startFixtureServer(timelineRoutes(split));
      const controller = new AbortController();
      let entered!: () => void;
      const ready = new Promise<void>((r) => (entered = r));
      let supply!: (w: WritableStream<Uint8Array>) => void;
      let aborted = 0;
      try {
        const task = new HlsDownloader({ adapter }).downloadToWritables(
          {
            url: server.origin + '/master.m3u8',
            ...timelineOptions(split),
            signal: controller.signal,
          },
          () => {
            entered();
            return new Promise((r) => (supply = r));
          },
        );
        const rejection = expect(task).rejects.toMatchObject({ code: 'ABORTED' });
        await ready;
        controller.abort();
        await rejection;
        supply(
          new WritableStream({
            abort() {
              aborted++;
            },
          }),
        );
        await new Promise((r) => setTimeout(r, 10));
        expect(aborted).toBe(1);
      } finally {
        await server.close();
      }
    });
    it('leaves a single caller writable unlocked after invalid range', async () => {
      const sink = new WritableStream<Uint8Array>();
      await expect(
        new HlsDownloader({ adapter }).downloadToWritable(
          {
            url: 'http://unused.invalid/',
            timeline: {
              range: { start: { ticks: '5', timescale: 1 }, end: { ticks: '2', timescale: 1 } },
            },
            maxRetry: 1,
          },
          sink,
        ),
      ).rejects.toMatchObject({ code: 'RANGE_INVALID' });
      expect(sink.locked).toBe(false);
    });
    it.each(timelineCases.filter((c) => c.name.startsWith('sample-') && !c.name.includes('range')))(
      'sample methods without timeline: $name',
      async (c) => {
        const server = await startFixtureServer(timelineRoutes(c));
        const requests: any[] = [];
        try {
          const options = timelineOptions(c);
          const resolver = options.decryption.keyResolver;
          const d = new HlsDownloader({ adapter });
          const chunks: Uint8Array[] = [];
          await d.downloadToWritable(
            {
              url: server.origin + '/master.m3u8',
              decryption: {
                ...options.decryption,
                keyResolver: async (r) => {
                  requests.push(r);
                  return resolver(r);
                },
              },
            },
            new WritableStream({
              write: (b) => {
                chunks.push(b);
              },
            }),
          );
          expect(chunks.length).toBeGreaterThan(0);
          expect(requests.some((r) => r.method.startsWith('SAMPLE-AES'))).toBe(true);
          if (c.name.includes('cenc') || c.name.includes('cbcs'))
            expect(requests.some((r) => r.kid === '00112233445566778899aabbccddeeff')).toBe(true);
          const path = resolve(dir, `${name}-${c.name}-sample.mp4`);
          writeFileSync(path, Buffer.concat(chunks));
          execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-']);
          if (!c.name.includes('dual')) {
            const clear = c.name.replace('sample-', '').replace(/_(cenc|cbcs|sample)$/, '_clear');
            const baseline = resolve(
              import.meta.dirname,
              'fixtures/sample-clear',
              clear,
              'input.m3u8',
            );
            const hashes = (file: string) =>
              execFileSync(
                'ffmpeg',
                ['-v', 'error', '-i', file, '-map', '0', '-f', 'framemd5', '-'],
                { encoding: 'utf8' },
              )
                .split('\n')
                .filter((l) => l && !l.startsWith('#'))
                .map((l) => l.split(',').at(-1)!.trim());
            expect(hashes(path)).toEqual(hashes(baseline));
          }
        } finally {
          await server.close();
        }
      },
    );
  });

for (const [name, adapter] of [
  ['browser', BrowserAdapter],
  ['node', NodeAdapter],
] as const)
  describe(`${name} timeline validation and sidecars`, () => {
    const base = timelineCases.find((c) => c.name === 'range-False');
    it('uses the same timeline without requiring an explicit option', async () => {
      const c = timelineCases.find((c) => c.name === 'clock-reset'),
        server = await startFixtureServer(timelineRoutes(c));
      try {
        const d = new HlsDownloader({ adapter });
        const ordinary = await d.downloadToStream(
          { url: server.origin + '/master.m3u8' },
          () => {},
        );
        expect(ordinary.report?.outputs).toHaveLength(1);
        const options = {
          url: server.origin + '/master.m3u8',
          timeline: {},
          filename: resolve(dir, name + '-single'),
        };
        const r = await d.download(options);
        if ('filePath' in r) publishedFiles.push(r.filePath);
        expect(r.report?.outputs).toHaveLength(1);
        if ('blobURL' in r) URL.revokeObjectURL(r.blobURL);
        const chunks: Uint8Array[] = [];
        const stream = await d.downloadToStream(options, (b) => {
          chunks.push(b);
        });
        expect(stream.report?.outputs).toHaveLength(1);
        expect(chunks.length).toBeGreaterThan(0);
      } finally {
        await server.close();
      }
    });
    it('exports subtitles from the completed report without rereading video or requesting keys', async () => {
      const routes = timelineRoutes(base);
      const primary = new URL(base.request.primary.url).pathname;
      routes['/master.m3u8'] = (_, res) => {
        res.writeHead(200);
        res.end(
          '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="en",URI="/sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,SUBTITLES="s"\n' +
            primary +
            '\n',
        );
      };
      routes['/sub.m3u8'] = (_, res) => {
        res.writeHead(200);
        res.end(
          '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXTINF:6,\n/sub.vtt\n#EXT-X-ENDLIST',
        );
      };
      let sourceTicks = '0';
      routes['/sub.vtt'] = (_, res) => {
        res.writeHead(200);
        res.end(
          'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:' +
            sourceTicks +
            '\n\nid\n00:00:01.000 --> 00:00:03.000 align:start\nHello',
        );
      };
      const server = await startFixtureServer(routes);
      try {
        const d = new HlsDownloader({ adapter }),
          r = await d.downloadOutputs({
            url: server.origin + '/master.m3u8',
            ...timelineOptions(base),
            filename: resolve(dir, name + '-sub'),
          });
        const m = r.report.timelineMap!.outputs[0]!.mappings.find(
          (m) => m.inputId === 'primary' && m.trackId === 1,
        )!;
        sourceTicks = (
          (BigInt(m.sourceOrigin.ticks) * 90000n) /
          BigInt(m.sourceOrigin.timescale)
        ).toString();
        const reads = server.requests.length;
        const out = await d.downloadSubtitleOutputs({
          url: server.origin + '/master.m3u8',
          subtitle: { groupId: 's', name: 'en' },
          timelineMap: r.report.timelineMap!,
        });
        expect(out.outputs[0]!.text).toContain('Hello');
        expect(out.outputs[0]!.text).toContain('align:start');
        expect(
          server.requests
            .slice(reads)
            .every((r) => r.path.endsWith('.m3u8') || r.path.endsWith('.vtt')),
        ).toBe(true);
        for (const o of r.outputs)
          if ('blobURL' in o) URL.revokeObjectURL(o.blobURL);
          else publishedFiles.push(o.filePath);
      } finally {
        await server.close();
      }
    });
    it('accepts explicit epoch anchors and rejects contradictory anchors', async () => {
      const c = structuredClone(timelineCases.find((c) => c.name === 'clock-reset'));
      let epoch = 0;
      c.request.primary.text = c.request.primary.text.replace(
        /#EXTINF/g,
        () => '#EXT-X-PROGRAM-DATE-TIME:2026-10-06T00:00:0' + epoch++ * 2 + 'Z\n#EXTINF',
      );
      const server = await startFixtureServer(timelineRoutes(c));
      try {
        const d = new HlsDownloader({ adapter }),
          options = { url: server.origin + '/master.m3u8', timeline: {} };
        const initial = await d.downloadToStream(options, () => {});
        const m = initial
          .report!.timelineMap!.outputs.flatMap((o) => o.mappings)
          .find((m) => m.epoch === '1')!;
        const anchor = {
          inputId: 'primary' as const,
          epoch: m.epoch,
          source: m.sourceOrigin,
          presentation: m.presentation.start,
        };
        const anchored = await d.downloadToStream(
          { ...options, timeline: { epochAnchors: [anchor] } },
          () => {},
        );
        expect(anchored.report?.actualRange).toEqual(initial.report?.actualRange);
        await expect(
          d.downloadToStream(
            {
              ...options,
              timeline: {
                epochAnchors: [{ ...anchor, presentation: { ticks: '100', timescale: 1 } }],
              },
            },
            () => {},
          ),
        ).rejects.toMatchObject({ code: 'TIMELINE_FAILED' });
      } finally {
        await server.close();
      }
    });
    it('rejects out-of-bounds ranges and clips a range ending after EOF', async () => {
      const server = await startFixtureServer(timelineRoutes(base));
      const t = (ticks: string) => ({ ticks, timescale: 1 });
      try {
        const d = new HlsDownloader({ adapter }),
          url = server.origin + '/master.m3u8';
        await expect(
          d.downloadToStream(
            { url, timeline: { range: { start: t('100'), end: t('101') } } },
            () => {},
          ),
        ).rejects.toMatchObject({ code: 'TIMELINE_FAILED', reason: 'MissingRandomAccess' });
        const result = await d.downloadToStream(
          { url, timeline: { range: { start: t('2'), end: t('100') } } },
          () => {},
        );
        expect(
          Number(result.report!.actualRange!.end.ticks) / result.report!.actualRange!.end.timescale,
        ).toBeLessThan(10);
        expect(result.report!.requestedRange?.end).toEqual(t('100'));
      } finally {
        await server.close();
      }
    });
    it('streams each resource once without a second planning fetch', async () => {
      const server = await startFixtureServer(timelineRoutes(base));
      try {
        const result = await new HlsDownloader({ adapter }).downloadToWritable(
          { url: server.origin + '/master.m3u8' },
          new WritableStream(),
        );
        expect(result.report?.inputs[0]?.committed).toBe('3');
        for (const path of new Set(
          server.requests.filter((r) => r.path.endsWith('.ts')).map((r) => r.path),
        ))
          expect(server.requests.filter((r) => r.path === path)).toHaveLength(1);
      } finally {
        await server.close();
      }
    });
  });

it('Node retains a published file when a later output acquisition fails', async () => {
  const c = structuredClone(timelineCases.find((c) => c.name === 'config-split'));
  // A third configuration makes the first output deterministically published
  // before the failing lease; observer delivery is deliberately asynchronous.
  c.request.primary.text = c.request.primary.text.replace(
    '#EXT-X-ENDLIST',
    '#EXT-X-DISCONTINUITY\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST',
  );
  const server = await startFixtureServer(timelineRoutes(c));
  const filename = 'timeline-partial-' + dir.split('/').at(-1);
  const first = resolve(filename + '.001.mp4'),
    second = resolve(filename + '.002.mp4');
  publishedFiles.push(first);
  try {
    const error = await new HlsDownloader({ adapter: NodeAdapter })
      .downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep',
        output: {
          type: 'files',
          format: 'mp4',
          acquire: async (o) => {
            if (o.index === '2') throw new Error('third destination unavailable');
            return o.index === '0' ? first : second;
          },
        },
        timeline: { changePolicy: 'split' },
      })
      .catch((e) => e);
    expect(error.code).toBe('OUTPUT_WRITE_FAILED');
    expect(error.adapter).toBe('NodeAdapter');
    expect(error.completedMultiTrackOutputs.map((o: any) => o.filePath)).toEqual([first]);
    expect(readFileSync(first).length).toBeGreaterThan(100);
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', first, '-f', 'null', '-'], {
      stdio: 'pipe',
    });
  } finally {
    rmSync(second, { recursive: true, force: true });
    await server.close();
  }
});

it('rejects incompatible bridge versions before host work', async () => {
  const native = await import('../packages/adapters/src/node/native.js');
  const wasm = await import('../packages/adapters/src/browser/wasm');
  await wasm.ensureWasm();
  let calls = 0;
  const unexpected = async (): Promise<never> => {
    calls++;
    throw Error('unexpected');
  };
  const request = JSON.stringify({ wireVersion: 2, bridgeVersion: 2 });
  expect(
    () =>
      new wasm.BrowserRecording(
        request,
        unexpected,
        unexpected,
        unexpected,
        unexpected,
        unexpected,
      ),
  ).toThrow(/BRIDGE_VERSION_MISMATCH/);
  expect(
    JSON.parse(
      native.continuousCreate(request, unexpected, unexpected, unexpected, unexpected, unexpected),
    ),
  ).toMatchObject({ error: { code: 'BRIDGE_VERSION_MISMATCH' } });
  expect(calls).toBe(0);
});
