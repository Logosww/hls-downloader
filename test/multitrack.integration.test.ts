import { createHash } from 'node:crypto';
import { canonicalMp4 } from './fixtures/mp4';
import { afterAll, expect, it, describe } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import {
  multiTrackRoutes,
  multiTrackSelection,
  packedRoutes,
  packedKey,
} from './fixtures/multitrack';
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
const dir = mkdtempSync(resolve(tmpdir(), 'hls-multitrack-'));
afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
const evidence: unknown[] = [];
afterAll(() => {
  mkdirSync(resolve(import.meta.dirname, '../test-results'), { recursive: true });
  writeFileSync(
    resolve(import.meta.dirname, '../test-results/multitrack-native.json'),
    JSON.stringify(evidence, null, 2),
  );
});
const adapters = [
  ['browser', BrowserAdapter],
  ['node', NodeAdapter],
] as const;
for (const embeddedAudio of ['keep', 'exclude'] as const)
  it(`two audio + two text tracks, embedded ${embeddedAudio}, native/WASM agreement`, async () => {
    const server = await startFixtureServer(multiTrackRoutes());
    try {
      const results = [];
      for (const [name, adapter] of adapters) {
        const chunks: Uint8Array[] = [];
        let closed = false;
        const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
          url: server.origin + '/master.m3u8',
          ...multiTrackSelection,
          embeddedAudio,
          output: {
            type: 'writable',
            writable: new WritableStream({
              write(b) {
                chunks.push(b);
              },
              close() {
                closed = true;
              },
            }),
          },
        });
        expect(closed).toBe(true);
        expect(result.report.tracks).toHaveLength(embeddedAudio === 'keep' ? 6 : 5);
        expect(result.report.tracks.filter((t) => t.kind === 'subtitle')).toHaveLength(2);
        expect(result.report.subtitleReports.length).toBeGreaterThanOrEqual(4);
        expect(result.report.subtitleReports.every((c) => c.disposition !== 'RejectedLate')).toBe(
          true,
        );
        const bytes = Buffer.concat(chunks),
          file = resolve(dir, name + '-' + embeddedAudio + '.mp4');
        writeFileSync(file, bytes);
        const probe = JSON.parse(
          execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString(),
        );
        expect(probe.streams).toHaveLength(result.report.tracks.length);
        expect(probe.streams.filter((s: any) => s.codec_tag_string === 'wvtt')).toHaveLength(2);
        const packets = (path: string) =>
          JSON.parse(
            execFileSync('ffprobe', [
              '-v',
              'error',
              '-show_packets',
              '-show_data_hash',
              'sha256',
              '-of',
              'json',
              path,
            ]).toString(),
          ).packets;
        const outputPackets = packets(file);
        const primaryPackets = packets(
          resolve(import.meta.dirname, 'fixtures/media/fmp4/media.m3u8'),
        );
        const audioPackets = packets(
          resolve(import.meta.dirname, 'fixtures/media/audio-fmp4/media.m3u8'),
        );
        for (const [index, track] of result.report.tracks.entries()) {
          if (track.kind === 'subtitle') continue;
          const source =
            track.inputId === 'primary'
              ? primaryPackets.filter((p: any) => p.codec_type === track.kind)
              : audioPackets;
          const actual = outputPackets.filter((p: any) => p.stream_index === index);
          expect(actual.map((p: any) => p.data_hash)).toEqual(source.map((p: any) => p.data_hash));
          expect(actual.length).toBe(Number(track.sampleCount));
          const shift = Number(actual[0].dts_time) - Number(source[0].dts_time);
          for (let i = 0; i < actual.length; i++) {
            expect(
              Math.abs(Number(actual[i].dts_time) - Number(source[i].dts_time) - shift),
            ).toBeLessThanOrEqual(1 / track.timescale);
            expect(
              Math.abs(Number(actual[i].pts_time) - Number(source[i].pts_time) - shift),
            ).toBeLessThanOrEqual(1 / track.timescale);
          }
        }

        execFileSync(
          'ffmpeg',
          ['-v', 'error', '-xerror', '-i', file, '-map', '0:v', '-map', '0:a', '-f', 'null', '-'],
          { stdio: 'pipe' },
        );
        const { peaks: _peaks, configurationId: _configurationId, ...report } = result.report;
        results.push({
          hash: createHash('sha256').update(canonicalMp4(bytes)).digest('hex'),
          report,
        });
      }
      expect(results[0]).toEqual(results[1]);
      evidence.push({ name: embeddedAudio, ...results[0] });
    } finally {
      await server.close();
    }
  });
// Independent ADTS framing reference: the transmuxer must retain each original
// AAC payload, including independently encrypted/rotated fixture variants.
const packedReference = [0, 1, 2, 3].flatMap((index) => {
  const b = readFileSync(resolve(import.meta.dirname, `fixtures/packed-aac/clear/seg${index}.bin`));
  let at =
    10 + ((b[6]! & 127) << 21) + ((b[7]! & 127) << 14) + ((b[8]! & 127) << 7) + (b[9]! & 127);
  const packets: string[] = [];
  while (at < b.length) {
    if (b[at] !== 255 || (b[at + 1]! & 240) !== 240)
      throw Error('Invalid independent ADTS fixture');
    const size = ((b[at + 3]! & 3) << 11) | (b[at + 4]! << 3) | (b[at + 5]! >> 5);
    const header = b[at + 1]! & 1 ? 7 : 9;
    if (size <= header || at + size > b.length) throw Error('ADTS size');
    packets.push(
      'SHA256:' +
        createHash('sha256')
          .update(b.subarray(at + header, at + size))
          .digest('hex'),
    );
    at += size;
  }
  return packets;
});
for (const kind of ['clear', 'aes128', 'sample_aes', 'aes128_rotation', 'sample_aes_rotation'])
  it(`Packed AAC ${kind} preserves 53 frames and 44.1kHz on both runtimes`, async () => {
    const server = await startFixtureServer(packedRoutes(kind));
    try {
      const payloads: string[][] = [];
      for (const [name, adapter] of adapters) {
        const chunks: Uint8Array[] = [];
        const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
          url: server.origin + '/input.m3u8',
          embeddedAudio: 'keep',
          decryption: { keyResolver: async (r) => ({ key: packedKey(r.uri) }) },
          output: {
            type: 'writable',
            writable: new WritableStream({
              write(b) {
                chunks.push(b);
              },
            }),
          },
        });
        const file = resolve(dir, `packed-${kind}-${name}.mp4`);
        writeFileSync(file, Buffer.concat(chunks));
        execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], {
          stdio: 'pipe',
        });
        const packets = JSON.parse(
          execFileSync('ffprobe', [
            '-v',
            'error',
            '-show_packets',
            '-show_data_hash',
            'sha256',
            '-of',
            'json',
            file,
          ]).toString(),
        );
        payloads.push(packets.packets.map((p: any) => p.data_hash));
        expect(result.report.tracks).toMatchObject([
          { kind: 'audio', codec: 'AacLc', timescale: 44100, sampleCount: '53' },
        ]);
      }
      expect(payloads[0]).toEqual(payloads[1]);
      expect(payloads[0]).toEqual(packedReference);
    } finally {
      await server.close();
    }
  });
for (const [name, adapter] of adapters)
  describe(name, () => {
    it('rejects unsupported playback before output acquisition', async () => {
      const server = await startFixtureServer(multiTrackRoutes());
      let acquired = false;
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            ...multiTrackSelection,
            playbackTarget: 'direct-browser',
            output: {
              type: 'writables',
              async acquire() {
                acquired = true;
                return new WritableStream();
              },
            },
          }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT', reason: 'BrowserTrackSelection' });
        expect(acquired).toBe(false);
      } finally {
        await server.close();
      }
    });
    it('rejects finite downloads of open inputs', async () => {
      const server = await startFixtureServer(multiTrackRoutes('', { open: true }));
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            ...multiTrackSelection,
            output: { type: 'writable', writable: new WritableStream() },
          }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_RENDITION' });
      } finally {
        await server.close();
      }
    });
    it('cancels immediately', async () => {
      const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
        url: 'http://127.0.0.1:1/a',
        embeddedAudio: 'keep',
        output: { type: 'writable', writable: new WritableStream() },
      });
      session.cancel();
      await expect(session.result).rejects.toMatchObject({ code: 'ABORTED' });
    });
    it('retains caller close failures', async () => {
      const server = await startFixtureServer(multiTrackRoutes());
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            ...multiTrackSelection,
            output: {
              type: 'writable',
              writable: new WritableStream({
                close() {
                  throw Error('sink');
                },
              }),
            },
          }),
        ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED', completedMultiTrackOutputs: [] });
      } finally {
        await server.close();
      }
    });
  });

it('classic Browser Blob and non-overwriting Native file preserve tracks', async () => {
  const server = await startFixtureServer(multiTrackRoutes());
  try {
    const options = { url: server.origin + '/master.m3u8', ...multiTrackSelection };
    const browser = await new HlsDownloader({ adapter: BrowserAdapter }).downloadMultiTrack({
      ...options,
      output: { type: 'blob', maxBytes: 8 * 1024 * 1024 },
    });
    const path = resolve(dir, 'classic.mp4');
    const native = await new HlsDownloader({ adapter: NodeAdapter }).downloadMultiTrack({
      ...options,
      output: { type: 'file', path },
    });
    expect(browser.report.tracks).toEqual(native.report.tracks);
    expect(canonicalMp4(new Uint8Array(await browser.blob.arrayBuffer()))).toEqual(
      canonicalMp4(readFileSync(path)),
    );
    await expect(
      new HlsDownloader({ adapter: NodeAdapter }).downloadMultiTrack({
        ...options,
        output: { type: 'file', path },
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
    await expect(
      new HlsDownloader({ adapter: BrowserAdapter }).downloadMultiTrack({
        ...options,
        output: { type: 'blob', maxBytes: 20 },
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
  } finally {
    await server.close();
  }
});
for (const [name, adapter] of adapters)
  describe(`${name} multi-track lifecycle`, () => {
    it('drains open inputs and accepted caption tails on stop', async () => {
      const server = await startFixtureServer(multiTrackRoutes('', { open: true }));
      let closed = false;
      try {
        const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
          url: server.origin + '/master.m3u8',
          ...multiTrackSelection,
          output: {
            type: 'writable',
            writable: new WritableStream({
              async write() {
                await new Promise((r) => setTimeout(r, 5));
              },
              close() {
                closed = true;
              },
            }),
          },
          onEvent(e) {
            if (e.type === 'progress') session.stop();
          },
        });
        const result = await session.result;
        expect(result.report.endReason).toBe('Stop');
        expect(result.report.tracks).toHaveLength(5);
        expect(result.report.subtitleReports.length).toBeGreaterThanOrEqual(4);
        expect(closed).toBe(true);
      } finally {
        await server.close();
      }
    });
    it('VOD pause/resume acknowledges and finishes all inputs', async () => {
      const server = await startFixtureServer(multiTrackRoutes());
      try {
        let pause: Promise<void> | undefined;
        const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
          url: server.origin + '/master.m3u8',
          ...multiTrackSelection,
          output: {
            type: 'writable',
            writable: new WritableStream({
              async write() {
                await new Promise((r) => setTimeout(r, 8));
              },
            }),
          },
          onEvent(e) {
            if (e.type === 'progress' && !pause)
              pause = session.pause().then(async () => {
                expect(session.state).toBe('paused');
                await session.resume();
              });
          },
        });
        await session.result;
        await pause;
        expect(pause).toBeDefined();
        expect(session.state).toBe('completed');
      } finally {
        await server.close();
      }
    });
    it('cancels blocked writer without waiting for it', async () => {
      const server = await startFixtureServer(multiTrackRoutes());
      try {
        const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
          url: server.origin + '/master.m3u8',
          ...multiTrackSelection,
          output: {
            type: 'writable',
            writable: new WritableStream({
              write() {
                session.cancel();
                return new Promise(() => {});
              },
            }),
          },
        });
        await expect(session.result).rejects.toMatchObject({ code: 'ABORTED' });
      } finally {
        await server.close();
      }
    });
    it('fails oversized initial subtitle admission without waiting forever', async () => {
      const server = await startFixtureServer(multiTrackRoutes());
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            ...multiTrackSelection,
            limits: { samples: 1 },
            output: { type: 'writable', writable: new WritableStream() },
          }),
        ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
      } finally {
        await server.close();
      }
    });
    it('rejects markup before output acquisition', async () => {
      const server = await startFixtureServer(
        multiTrackRoutes('', { subtitle: 'WEBVTT\n\n00:00.000 --> 00:01.000\n<b>hello</b>\n' }),
      );
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            ...multiTrackSelection,
            output: {
              type: 'writables',
              acquire() {
                throw Error('must not acquire');
              },
            },
          }),
        ).rejects.toMatchObject({
          code: 'UNSUPPORTED_RENDITION',
          reason: 'UnsupportedSubtitleProfile',
        });
      } finally {
        await server.close();
      }
    });
  });

for (const primary of ['ts', 'fmp4'])
  for (const audio of ['audio-ts', 'audio-fmp4'])
    it(`mixed ${primary}/${audio} inputs retain independent clocks`, async () => {
      const server = await startFixtureServer(multiTrackRoutes('', { primary, audio }));
      try {
        for (const [, adapter] of adapters) {
          const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            ...multiTrackSelection,
            output: { type: 'writable', writable: new WritableStream() },
          });
          expect(result.report.tracks).toHaveLength(5);
          expect(result.report.inputs).toHaveLength(3);
          expect(result.report.inputs.every((i) => i.accepted === i.committed)).toBe(true);
        }
      } finally {
        await server.close();
      }
    });

import { timelineCases, timelineRoutes, timelineOptions } from './fixtures/timeline';
for (const c of timelineCases.filter(
  (c) =>
    c.name.startsWith('sample-') ||
    ['range-False', 'dual-True', 'gap-collapse', 'config-split'].includes(c.name),
))
  it(`multi-track range/epoch/encryption ${c.name}`, async () => {
    const server = await startFixtureServer(timelineRoutes(c));
    try {
      const reports = [];
      for (const [, adapter] of adapters) {
        let closed = 0;
        const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
          url: server.origin + '/master.m3u8',
          embeddedAudio: c.request.audio ? 'exclude' : 'keep',
          audioTracks: c.request.audio
            ? [{ id: 'selected', selector: { groupId: 'a', name: 'en' } }]
            : [],
          ...timelineOptions(c),
          missingSegments: 'skip',
          output: {
            type: 'writables',
            async acquire() {
              return new WritableStream({
                close() {
                  closed++;
                },
              });
            },
          },
        });
        expect(result.report.outputs.length).toBe(closed);
        expect(closed).toBe(c.name === 'config-split' ? 2 : 1);
        expect(result.report.tracks.length).toBeGreaterThan(0);
        const { configurationId: _configurationId, peaks: _peaks, ...report } = result.report;
        reports.push(report);
      }
      expect(reports[0]).toEqual(reports[1]);
    } finally {
      await server.close();
    }
  });

for (const [name, adapter] of adapters)
  describe(`${name} caption timeline`, () => {
    it('drains accepted subtitle tail beyond independent media EOF', async () => {
      const server = await startFixtureServer(
        multiTrackRoutes('', { subtitle: 'WEBVTT\n\n00:00.100 --> 00:03.000\ntail\n' }),
      );
      try {
        const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
          url: server.origin + '/master.m3u8',
          ...multiTrackSelection,
          output: { type: 'writable', writable: new WritableStream() },
        });
        expect(
          result.report.subtitleReports.some((c) => Number(c.end.ticks) / c.end.timescale === 3),
        ).toBe(true);
      } finally {
        await server.close();
      }
    });
    it('refreshes subtitle windows, deduplicates resources and reports late cues', async () => {
      const routes = multiTrackRoutes('', { open: true });
      const media = routes['/video/media.m3u8']!;
      routes['/video/media.m3u8'] = (req, res) => {
        if (req.attempt === 1) return media(req, res);
        const text = readFileSync(
          resolve(import.meta.dirname, 'fixtures/media/fmp4/media.m3u8'),
          'utf8',
        );
        res.end(text);
      };
      routes['/cc-en/media.m3u8'] = (req, res) =>
        res.end(
          req.attempt < 3
            ? '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\ntext.vtt\n'
            : '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1,\nlate.vtt\n#EXT-X-ENDLIST\n',
        );
      routes['/cc-en/late.vtt'] = (_, res) =>
        res.end('WEBVTT\n\nlate\n00:00.000 --> 00:00.100\nlate\n');
      const server = await startFixtureServer(routes);
      try {
        const result = await new HlsDownloader({ adapter }).startMultiTrackRecording({
          url: server.origin + '/master.m3u8',
          embeddedAudio: 'keep',
          subtitleTracks: [multiTrackSelection.subtitleTracks[0]!],
          output: { type: 'writable', writable: new WritableStream() },
        }).result;
        expect(server.attempts.get('/cc-en/text.vtt')).toBe(1);
        expect(
          result.report.subtitleReports.some(
            (c) => c.identifier === 'late' && c.disposition === 'RejectedLate',
          ),
        ).toBe(true);
      } finally {
        await server.close();
      }
    });
    it('cancels initial subtitle fetch without leaking the session', async () => {
      const routes = multiTrackRoutes();
      routes['/cc-en/text.vtt'] = async (_, res) => {
        await new Promise((r) => setTimeout(r, 80));
        res.end('WEBVTT\n');
      };
      const server = await startFixtureServer(routes);
      try {
        const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
          url: server.origin + '/master.m3u8',
          ...multiTrackSelection,
          output: { type: 'writable', writable: new WritableStream() },
        });
        const timer = setInterval(() => {
          if (server.attempts.has('/cc-en/text.vtt')) {
            clearInterval(timer);
            session.cancel();
          }
        }, 2);
        try {
          await expect(session.result).rejects.toMatchObject({ code: 'ABORTED' });
        } finally {
          clearInterval(timer);
        }
      } finally {
        await server.close();
      }
    });
  });

for (const [name, adapter] of adapters)
  describe(`${name} multi-track controls and failures`, () => {
    it('cancels key resolution and ignores its late completion', async () => {
      const server = await startFixtureServer(packedRoutes('aes128'));
      let entered!: () => void, late!: (value: { key: Uint8Array }) => void;
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      try {
        let writes = 0;
        const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
          url: server.origin + '/input.m3u8',
          embeddedAudio: 'keep',
          decryption: {
            keyResolver: async () => {
              entered();
              return new Promise((r) => {
                late = r;
              });
            },
          },
          output: {
            type: 'writable',
            writable: new WritableStream({
              write() {
                writes++;
              },
            }),
          },
        });
        await ready;
        session.cancel();
        await expect(session.result).rejects.toMatchObject({ code: 'ABORTED' });
        const stoppedWrites = writes;
        late({ key: packedKey('key') });
        await new Promise((r) => setTimeout(r, 20));
        expect(writes).toBe(stoppedWrites);
      } finally {
        await server.close();
      }
    });
    it('preserves closed split outputs on a subsequent sink failure', async () => {
      const c = timelineCases.find((c) => c.name === 'config-split');
      const server = await startFixtureServer(timelineRoutes(c));
      const closed: string[] = [];
      try {
        const result = new HlsDownloader({ adapter }).downloadMultiTrack({
          url: server.origin + '/master.m3u8',
          embeddedAudio: 'keep',
          timeline: { changePolicy: 'split' },
          output: {
            type: 'writables',
            async acquire(output) {
              return new WritableStream({
                write() {
                  if (output.index === '1') throw Error('second sink');
                },
                close() {
                  closed.push(output.index);
                },
              });
            },
          },
        });
        const error = await result.catch((e) => e);
        expect(error.code).toBe('OUTPUT_WRITE_FAILED');
        expect(error.completedMultiTrackOutputs.map((o: any) => o.index)).toEqual(closed);
        expect(closed).toEqual(['0']);
      } finally {
        await server.close();
      }
    });
    it('uses lossless generations for repeated restart with bounded history', async () => {
      const c = structuredClone(timelineCases.find((c) => c.name === 'sample-fmp4_aac_cenc'));
      const lines = c.request.primary.text.replace(/^#EXT-X-ENDLIST.*\n?/gm, '').split('\n');
      const first = lines.findIndex((line: string) => line.trim() && !line.startsWith('#'));
      c.request.primary.text = lines.slice(0, first + 1).join('\n') + '\n';
      const server = await startFixtureServer(timelineRoutes(c));
      try {
        let count = 0,
          generation = 9007199254740993n,
          pending: Promise<void> | undefined,
          failure: unknown;
        const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
          url: server.origin + '/master.m3u8',
          embeddedAudio: 'keep',
          limits: { historyEntries: 4, queuedDescriptors: 2 },
          decryption: timelineOptions(c).decryption,
          output: { type: 'writable', writable: new WritableStream() },
          onEvent(e) {
            if (e.type === 'progress') {
              count++;
              if (count === 32) session.stop();
              else
                pending = session
                  .restartInput('primary', { generation: (generation++).toString() })
                  .catch((e) => {
                    failure = e;
                    session.cancel();
                  });
            }
          },
        });
        const result = await session.result;
        await pending;
        if (failure) throw failure;
        expect(count).toBe(32);
        expect(result.report.historyTruncated).toBe(true);
        expect(result.report.mappings.length).toBeLessThanOrEqual(4);
        expect(BigInt(result.report.inputs[0]!.committedSlot!.generation)).toBeGreaterThan(
          9007199254740992n,
        );
      } finally {
        await server.close();
      }
    });
  });

it('configuration splits retain both audio identities and both subtitle tracks', async () => {
  const c = structuredClone(timelineCases.find((c) => c.name === 'config-split'));
  let epoch = 0;
  c.request.primary.text = c.request.primary.text.replace(
    /#EXTINF/g,
    () => '#EXT-X-PROGRAM-DATE-TIME:2026-10-06T00:00:0' + epoch++ * 2 + 'Z\n#EXTINF',
  );
  const timeline = timelineRoutes(c);
  const media = timeline[new URL(c.request.primary.url).pathname]!;
  const routes = { ...timeline, ...multiTrackRoutes() };
  for (const lane of ['video', 'en', 'ja']) routes[`/${lane}/media.m3u8`] = media;
  for (const language of ['en', 'ja']) {
    routes[`/cc-${language}/media.m3u8`] = (_, res) =>
      res.end(
        '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.vtt\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nb.vtt\n#EXT-X-ENDLIST\n',
      );
    for (const part of ['a', 'b'])
      routes[`/cc-${language}/${part}.vtt`] = (_, res) =>
        res.end(
          `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:126000\n\n${language}-${part}\n00:00.100 --> 00:01.700\n${language}\n`,
        );
  }
  const server = await startFixtureServer(routes);
  try {
    for (const [, adapter] of adapters) {
      const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        ...multiTrackSelection,
        timeline: { changePolicy: 'split' },
        output: {
          type: 'writables',
          async acquire() {
            return new WritableStream();
          },
        },
      });
      expect(result.report.outputs).toHaveLength(2);
      for (const outputIndex of ['0', '1']) {
        const tracks = result.report.tracks.filter((t) => t.outputIndex === outputIndex);
        expect(tracks).toHaveLength(5);
        expect(tracks.filter((t) => t.kind === 'audio').map((t) => t.inputId)).toEqual([
          'english',
          'japanese',
        ]);
        expect(
          result.report.subtitleReports.filter((c) => c.outputIndex === outputIndex).length,
        ).toBeGreaterThanOrEqual(2);
      }
      expect(result.report.tracks.filter((t) => t.outputIndex === '0').map((t) => t.id)).toEqual(
        result.report.tracks.filter((t) => t.outputIndex === '1').map((t) => t.id),
      );
    }
  } finally {
    await server.close();
  }
});

it('deduplicates a cue repeated in consecutive subtitle resources', async () => {
  const routes = multiTrackRoutes();
  routes['/cc-en/media.m3u8'] = (_, res) =>
    res.end(
      '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\na.vtt\n#EXTINF:1,\nb.vtt\n#EXT-X-ENDLIST\n',
    );
  for (const part of ['a', 'b'])
    routes[`/cc-en/${part}.vtt`] = (_, res) =>
      res.end('WEBVTT\n\nrepeat\n00:00.100 --> 00:01.000\nhello\n');
  const server = await startFixtureServer(routes);
  try {
    for (const [, adapter] of adapters) {
      let accepted = 0;
      const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep',
        subtitleTracks: [multiTrackSelection.subtitleTracks[0]!],
        onEvent(e) {
          if (e.type === 'subtitles') accepted += e.accepted;
        },
        output: { type: 'writable', writable: new WritableStream() },
      });
      expect(accepted).toBe(1);
      expect(result.report.subtitleReports.filter((c) => c.identifier === 'repeat')).toHaveLength(
        1,
      );
    }
  } finally {
    await server.close();
  }
});

for (const [name, adapter] of adapters)
  it(`${name} playback target distinguishes preserved and collapsed decode gaps`, async () => {
    const c = timelineCases.find((c) => c.name === 'gap-collapse');
    const server = await startFixtureServer(timelineRoutes(c));
    try {
      const downloader = new HlsDownloader({ adapter });
      const options = {
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep' as const,
        playbackTarget: 'avfoundation' as const,
        missingSegments: 'skip' as const,
        ...timelineOptions(c),
      };
      const collapsed = await downloader.downloadMultiTrack({
        ...options,
        output: { type: 'writable', writable: new WritableStream() },
      });
      expect(collapsed.report.gapCount).not.toBe('0');
      await expect(
        downloader.downloadMultiTrack({
          ...options,
          timeline: { gapPolicy: 'preserve' },
          output: { type: 'writable', writable: new WritableStream() },
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT', reason: 'DecodeGaps' });
    } finally {
      await server.close();
    }
  });

for (const [name, adapter] of adapters) {
  it(`${name} rejects duplicate selections and conflicting defaults before output creation`, async () => {
    const server = await startFixtureServer(multiTrackRoutes());
    let acquired = 0;
    try {
      const downloader = new HlsDownloader({ adapter });
      for (const selection of [
        {
          audioTracks: [
            { id: 'first', selector: { language: 'en' } },
            { id: 'second', selector: { groupId: 'a', name: 'English' } },
          ],
        },
        {
          audioTracks: multiTrackSelection.audioTracks.map((t) => ({
            ...t,
            metadata: { default: true },
          })),
        },
        {
          subtitleTracks: multiTrackSelection.subtitleTracks.map((t) => ({
            ...t,
            metadata: { default: true },
          })),
        },
        { audioTracks: [{ id: 'first', selector: { groupId: 'unrelated', name: 'English' } }] },
      ]) {
        await expect(
          downloader.downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            embeddedAudio: 'exclude',
            ...selection,
            output: {
              type: 'writables',
              async acquire() {
                acquired++;
                return new WritableStream();
              },
            },
          }),
        ).rejects.toBeInstanceOf(Error);
      }
      expect(acquired).toBe(0);
      const result = await downloader.downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        ...multiTrackSelection,
        audioTracks: multiTrackSelection.audioTracks.map((t) => ({
          ...t,
          metadata: { default: false },
        })),
        subtitleTracks: [],
        output: { type: 'writable', writable: new WritableStream() },
      });
      expect(
        result.report.tracks.filter((t) => t.kind === 'audio').map((t) => t.metadata.default),
      ).toEqual([true, false]);
    } finally {
      await server.close();
    }
  });
  for (const [playbackTarget, reason] of [
    ['vlc', 'SubtitleSettings'],
    ['iina', 'WvttDecoder'],
    ['ffmpeg', 'WvttDecoder'],
  ] as const)
    it(`${name} exposes ${playbackTarget} subtitle capability rejection`, async () => {
      const server = await startFixtureServer(multiTrackRoutes());
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            ...multiTrackSelection,
            playbackTarget,
            output: { type: 'writable', writable: new WritableStream() },
          }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT', reason });
      } finally {
        await server.close();
      }
    });
}
