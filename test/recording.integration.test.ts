import { createAdapter, getInternalAdapter } from '@hls-downloader/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HlsDownloader } from '../packages/core/src/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { timelineCases, timelineRoutes, timelineOptions } from './fixtures/timeline';
import { startFixtureServer, sendText } from './fixtures/http-server';
import type { HlsRecordingSession } from '../packages/shared/src/recording';
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
const dir = mkdtempSync(resolve(tmpdir(), 'hls-recording-'));
const evidence: unknown[] = [];
afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
  if (evidence.length === profiles.length) {
    mkdirSync(resolve(import.meta.dirname, '../test-results'), { recursive: true });
    writeFileSync(
      resolve(import.meta.dirname, '../test-results/recording-native.json'),
      JSON.stringify(evidence, null, 2),
    );
  }
});
function openCase(c: any) {
  const copy = structuredClone(c);
  for (const s of [copy.request.primary, copy.request.audio].filter(Boolean))
    s.text = s.text
      .replace(/^#EXT-X-ENDLIST.*\n?/gm, '')
      .replace(/^#EXT-X-PLAYLIST-TYPE.*\n?/gm, '');
  return copy;
}
function canonical(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  const visit = (start: number, end: number) => {
    for (let i = start; i + 8 <= end;) {
      const size = b.readUInt32BE(i),
        kind = b.toString('ascii', i + 4, i + 8);
      if (size < 8 || i + size > end) throw Error('Invalid MP4');
      if (['moov', 'trak', 'mdia'].includes(kind)) visit(i + 8, i + size);
      if (['mvhd', 'tkhd', 'mdhd'].includes(kind))
        b.fill(0, i + 12, i + (b[i + 8] === 1 ? 28 : 20));
      i += size;
    }
  };
  visit(0, b.length);
  return b;
}
const profiles = timelineCases.filter(
  (c) =>
    ['range-False', 'range-True', 'dual-False', 'dual-True'].includes(c.name) ||
    (c.name.startsWith('sample-') && c.name !== 'sample-range-key-redeclaration'),
);
for (const c of profiles)
  it(`continuous native/WASM ${c.name}`, async () => {
    const server = await startFixtureServer(timelineRoutes(openCase(c)));
    try {
      const results = [];
      for (const [name, adapter] of [
        ['browser', BrowserAdapter],
        ['node', NodeAdapter],
      ] as const) {
        const chunks: Uint8Array[] = [];
        let closed = false;
        let session: HlsRecordingSession;
        session = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          decryption: timelineOptions(c).decryption,
          output: {
            type: 'writable',
            writable: new WritableStream({
              write(bytes) {
                chunks.push(bytes);
              },
              close() {
                closed = true;
              },
            }),
          },
          onEvent(event) {
            if (event.type === 'progress') session.stop();
          },
        });
        const result = await session.result;
        expect(session.state).toBe('completed');
        expect(closed).toBe(true);
        expect(result.report.endReason).toBe('Stop');
        expect(
          result.report.inputs.every((p) => p.committed === p.accepted && p.total === null),
        ).toBe(true);
        const bytes = canonical(Buffer.concat(chunks));
        expect(bytes.length).toBeGreaterThan(100);
        const path = resolve(dir, c.name + '-' + name + '.mp4');
        writeFileSync(path, bytes);
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', path], { stdio: 'pipe' });
        execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], {
          stdio: 'pipe',
        });
        const { peaks, ...stableReport } = result.report;
        expect(BigInt(peaks.queuedDescriptors)).toBeLessThanOrEqual(128n);
        results.push({
          hash: createHash('sha256').update(bytes).digest('hex'),
          report: stableReport,
        });
      }
      expect(results[0]).toEqual(results[1]);
      evidence.push({ name: c.name, ...results[0] });
    } finally {
      await server.close();
    }
  });
const clear = timelineCases.find((c) => c.name === 'range-False');
for (const [name, adapter] of [
  ['browser', BrowserAdapter],
  ['node', NodeAdapter],
] as const)
  describe(`${name} recording lifecycle`, () => {
    it('stops during initial fetch without cancelling the recording', async () => {
      const server = await startFixtureServer({
        '/live.m3u8': async (_, res) => {
          await new Promise((r) => setTimeout(r, 70));
          sendText(res, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n');
        },
      });
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/live.m3u8',
          output: { type: 'writable', writable: new WritableStream() },
        });
        s.stop();
        expect((await s.result).report.endReason).toBe('Stop');
        expect(s.state).toBe('completed');
      } finally {
        await server.close();
      }
    });
    it('cancels before preparation', async () => {
      const s = new HlsDownloader({ adapter }).startRecording({
        url: 'http://127.0.0.1:1/a',
        output: { type: 'writable', writable: new WritableStream() },
      });
      s.cancel();
      await expect(s.result).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
      expect(s.state).toBe('cancelled');
    });
    it('rejects live pause without failing the operation; drains slow writes and awaits close', async () => {
      const server = await startFixtureServer(timelineRoutes(openCase(clear)));
      let writes = 0,
        closed = false,
        overlap = false,
        busy = false;
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: {
            type: 'writable',
            writable: new WritableStream({
              async write() {
                if (busy) overlap = true;
                busy = true;
                writes++;
                await new Promise((r) => setTimeout(r, 10));
                busy = false;
              },
              async close() {
                await new Promise((r) => setTimeout(r, 20));
                closed = true;
              },
            }),
          },
        });
        await expect(s.pause()).rejects.toMatchObject({
          code: 'RECORDING_FAILED',
          reason: 'PauseUnsupported',
        });
        while (writes < 2) await new Promise((r) => setTimeout(r, 10));
        s.stop();
        await s.result;
        expect(closed).toBe(true);
        expect(overlap).toBe(false);
      } finally {
        await server.close();
      }
    });
    it('acknowledges VOD pause and resumes to EOF', async () => {
      const server = await startFixtureServer(timelineRoutes(clear));
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: {
            type: 'writable',
            writable: new WritableStream({
              async write() {
                await new Promise((r) => setTimeout(r, 15));
              },
            }),
          },
        });
        await s.pause();
        expect(s.state).toBe('paused');
        await s.resume();
        expect((await s.result).report.endReason).toBe('Eof');
      } finally {
        await server.close();
      }
    });
    it('close rejection prevents completion', async () => {
      const server = await startFixtureServer(timelineRoutes(clear));
      const states: string[] = [];
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: {
            type: 'writable',
            writable: new WritableStream({
              close() {
                throw Error('close rejected');
              },
            }),
          },
          onEvent(e) {
            if (e.type === 'state') states.push(e.state);
          },
        });
        await expect(s.result).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
        expect(states).not.toContain('completed');
      } finally {
        await server.close();
      }
    });
    it('cancels a pending sink write without waiting for the sink', async () => {
      const server = await startFixtureServer(timelineRoutes(openCase(clear)));
      let writing!: () => void;
      const started = new Promise<void>((r) => (writing = r));
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: {
            type: 'writable',
            writable: new WritableStream({
              write() {
                writing();
                return new Promise(() => {});
              },
            }),
          },
        });
        await started;
        s.cancel();
        await expect(s.result).rejects.toMatchObject({ code: 'ABORTED' });
      } finally {
        await server.close();
      }
    });
    it('reports atomic queue limits', async () => {
      const server = await startFixtureServer(timelineRoutes(openCase(clear)));
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          limits: { queuedDescriptors: 1 },
          output: { type: 'writable', writable: new WritableStream() },
        });
        await expect(s.result).rejects.toMatchObject({
          code: 'RESOURCE_LIMIT_EXCEEDED',
          reason: 'QueueLimit',
        });
      } finally {
        await server.close();
      }
    });
    it('rejects implicit split and unsupported output combinations', async () => {
      const s = new HlsDownloader({ adapter }).startRecording({
        url: 'http://127.0.0.1:1/a',
        timeline: { changePolicy: 'split' },
        output: { type: 'writable', writable: new WritableStream() },
      });
      await expect(s.result).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
    });
    it('ends an open input explicitly', async () => {
      const server = await startFixtureServer(timelineRoutes(openCase(clear)));
      let s: HlsRecordingSession;
      let ending: Promise<void> | undefined;
      try {
        s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: { type: 'writable', writable: new WritableStream() },
          onEvent(e) {
            if (e.type === 'progress' && !ending) ending = s.endInput('primary');
          },
        });
        expect((await s.result).report.endReason).toBe('Eof');
        await ending;
      } finally {
        await server.close();
      }
    });
  });
it('Browser bounded Blob classic/fMP4 and overflow', async () => {
  const server = await startFixtureServer(timelineRoutes(clear));
  try {
    for (const format of ['mp4', 'fmp4'] as const) {
      const s = new HlsDownloader({ adapter: BrowserAdapter }).startRecording({
        url: server.origin + '/master.m3u8',
        output: { type: 'blob', format, maxBytes: 16 * 1024 * 1024 },
      });
      const r = await s.result;
      expect(r.blob.size).toBeGreaterThan(100);
      const path = resolve(dir, 'blob-' + format + '.mp4');
      writeFileSync(path, Buffer.from(await r.blob.arrayBuffer()));
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], {
        stdio: 'pipe',
      });
    }
    const s = new HlsDownloader({ adapter: BrowserAdapter }).startRecording({
      url: server.origin + '/master.m3u8',
      output: { type: 'blob', maxBytes: 100 },
    });
    await expect(s.result).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
  } finally {
    await server.close();
  }
});
it('Node native classic/fMP4 publication never clobbers', async () => {
  const server = await startFixtureServer(timelineRoutes(clear));
  try {
    for (const format of ['mp4', 'fmp4'] as const) {
      const path = resolve(dir, 'node-' + format + '.mp4');
      const options = {
        url: server.origin + '/master.m3u8',
        output: { type: 'file' as const, path, format },
      };
      const r = await new HlsDownloader({ adapter: NodeAdapter }).startRecording(options).result;
      expect(r.filePath).toBe(path);
      expect(existsSync(path)).toBe(true);
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], {
        stdio: 'pipe',
      });
      const bytes = readFileSync(path);
      await expect(
        new HlsDownloader({ adapter: NodeAdapter }).startRecording(options).result,
      ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
      expect(readFileSync(path)).toEqual(bytes);
    }
  } finally {
    await server.close();
  }
});

function clearWindow(count: number, sequence = 0, ended = false) {
  const lines = clear.request.primary.text.replace(/^#EXT-X-ENDLIST.*\n?/gm, '').split('\n');
  const header = lines
    .slice(
      0,
      lines.findIndex((l: string) => l.startsWith('#EXTINF')),
    )
    .join('\n')
    .replace(/#EXT-X-MEDIA-SEQUENCE:\d+/, `#EXT-X-MEDIA-SEQUENCE:${sequence}`);
  const pairs: string[] = [];
  for (let i = 0; i < lines.length; i++)
    if (lines[i].startsWith('#EXTINF')) pairs.push(lines[i] + '\n' + lines[i + 1]);
  return (
    header +
    '\n' +
    pairs.slice(sequence, sequence + count).join('\n') +
    '\n' +
    (ended ? '#EXT-X-ENDLIST\n' : '')
  );
}
for (const [name, adapter] of [
  ['browser', BrowserAdapter],
  ['node', NodeAdapter],
] as const)
  describe(`${name} recording snapshots`, () => {
    it('refreshes overlapping windows, ignores duplicates, writes before ENDLIST', async () => {
      const routes = timelineRoutes(clear),
        path = new URL(clear.request.primary.url).pathname;
      let wrote = false,
        refreshed = false;
      routes[path] = (req, res) => {
        if (req.attempt >= 2) refreshed = true;
        sendText(res, req.attempt < 3 ? clearWindow(2) : clearWindow(2, 1, true));
      };
      const server = await startFixtureServer(routes);
      try {
        const result = await new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: {
            type: 'writable',
            writable: new WritableStream({
              write() {
                if (!refreshed) wrote = true;
              },
            }),
          },
        }).result;
        expect(wrote).toBe(true);
        expect(result.report.inputs[0].committed).toBe('3');
        expect(result.report.inputs[0].accepted).toBe('3');
        expect(result.report.endReason).toBe('Eof');
        expect(server.attempts.get(path)).toBe(3);
      } finally {
        await server.close();
      }
    });
    it('waits through an empty initial window', async () => {
      const routes = timelineRoutes(clear),
        path = new URL(clear.request.primary.url).pathname;
      routes[path] = (req, res) =>
        sendText(res, req.attempt === 1 ? clearWindow(0) : clearWindow(3, 0, true));
      const server = await startFixtureServer(routes);
      try {
        const r = await new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: { type: 'writable', writable: new WritableStream() },
        }).result;
        expect(r.report.inputs[0].committed).toBe('3');
      } finally {
        await server.close();
      }
    });
    it('fails resource rewrites rather than silently restarting', async () => {
      const routes = timelineRoutes(clear),
        path = new URL(clear.request.primary.url).pathname;
      routes[path] = (req, res) =>
        sendText(
          res,
          clearWindow(3).replace('seg0.ts', req.attempt === 1 ? 'seg0.ts' : 'seg0.ts?changed=1'),
        );
      const server = await startFixtureServer(routes);
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: { type: 'writable', writable: new WritableStream() },
        });
        await expect(s.result).rejects.toMatchObject({
          code: 'RESOURCE_CHANGED',
          reason: 'InputRewrite',
        });
      } finally {
        await server.close();
      }
    });
    it('preserves completed split outputs on a later factory rejection', async () => {
      const c = timelineCases.find((c) => c.name === 'config-split'),
        server = await startFixtureServer(timelineRoutes(c));
      let acquisitions = 0,
        closed = 0;
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          timeline: { changePolicy: 'split' },
          output: {
            type: 'writables',
            async acquire() {
              acquisitions++;
              if (acquisitions === 2) throw Error('reject second');
              return new WritableStream({
                close() {
                  closed++;
                },
              });
            },
          },
        });
        const error = await s.result.catch((e) => e);
        expect(error.code).toBe('OUTPUT_WRITE_FAILED');
        // Upstream acquires the replacement before completing the old output.
        expect(error.completedRecordingOutputs).toHaveLength(closed);
      } finally {
        await server.close();
      }
    });
    it('supports declared GAP skip/collapse and configuration splits', async () => {
      for (const caseName of ['gap-collapse', 'config-split']) {
        const c = timelineCases.find((c) => c.name === caseName),
          server = await startFixtureServer(timelineRoutes(c));
        let closed = 0;
        try {
          const r = await new HlsDownloader({ adapter }).startRecording({
            url: server.origin + '/master.m3u8',
            missingSegments: 'skip',
            timeline: {
              gapPolicy: caseName === 'gap-collapse' ? 'collapse' : 'preserve',
              changePolicy: 'split',
            },
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
          }).result;
          expect(closed).toBeGreaterThan(0);
          expect(r.report.outputs.length).toBe(closed);
          if (caseName === 'config-split') expect(closed).toBe(2);
        } finally {
          await server.close();
        }
      }
    });
    it('bounds recent mappings and output history', async () => {
      const c = timelineCases.find((c) => c.name === 'config-split'),
        server = await startFixtureServer(timelineRoutes(c));
      let observed = 0;
      try {
        const r = await new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          limits: { historyEntries: 1 },
          timeline: { changePolicy: 'split' },
          output: {
            type: 'writables',
            async acquire() {
              return new WritableStream();
            },
          },
          onEvent(e) {
            if (e.type === 'output') observed++;
          },
        }).result;
        expect(observed).toBe(2);
        expect(r.report.outputs).toHaveLength(1);
        expect(r.report.historyTruncated).toBe(true);
        expect(r.report.mappings.length).toBeLessThanOrEqual(1);
      } finally {
        await server.close();
      }
    });
    it('cancels key waits and ignores late resolver completion', async () => {
      const c = timelineCases.find((c) => c.name === 'sample-fmp4_avc_cenc'),
        server = await startFixtureServer(timelineRoutes(openCase(c)));
      let entered!: () => void, late!: (value: any) => void;
      const waiting = new Promise<void>((r) => (entered = r));
      let writes = 0;
      try {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          decryption: {
            keyResolver: () => {
              entered();
              return new Promise((r) => (late = r));
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
        await waiting;
        s.cancel();
        await expect(s.result).rejects.toMatchObject({ code: 'ABORTED' });
        late({ key: new Uint8Array(16) });
        await new Promise((r) => setTimeout(r, 20));
        expect(writes).toBe(0);
      } finally {
        await server.close();
      }
    });
    it('supports requested ranges and duration drain reports', async () => {
      const server = await startFixtureServer(timelineRoutes(clear));
      try {
        const r = await new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          timeline: timelineOptions(clear).timeline,
          output: { type: 'writable', writable: new WritableStream() },
        }).result;
        expect(r.report.requestedRange).toEqual(clear.selection.range);
        expect(r.report.actualRange).not.toBeNull();
      } finally {
        await server.close();
      }
      const live = await startFixtureServer(timelineRoutes(openCase(clear)));
      try {
        const r = await new HlsDownloader({ adapter }).startRecording({
          url: live.origin + '/master.m3u8',
          durationLimit: { ticks: '1', timescale: 1 },
          output: { type: 'writable', writable: new WritableStream() },
        }).result;
        expect(r.report.endReason).toBe('DurationLimit');
      } finally {
        await live.close();
      }
    });
  });

for (const [name, adapter] of [
  ['browser', BrowserAdapter],
  ['node', NodeAdapter],
] as const) {
  it(`${name} explicit large-generation restart and bounded long recording`, async () => {
    const c = openCase(timelineCases.find((c) => c.name === 'sample-fmp4_aac_cenc'));
    const lines = c.request.primary.text.split('\n');
    const first = lines.findIndex((l: string) => l.trim() && !l.startsWith('#'));
    c.request.primary.text = lines.slice(0, first + 1).join('\n') + '\n';
    const server = await startFixtureServer(timelineRoutes(c));
    const measurements = [];
    try {
      for (const count of [8, 64, 256]) {
        let generation = 9007199254740993n,
          observed = 0,
          pending: Promise<void> | undefined,
          controlFailure: unknown;
        let s: HlsRecordingSession;
        s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          limits: { historyEntries: 4, queuedDescriptors: 2 },
          decryption: timelineOptions(c).decryption,
          output: { type: 'writable', writable: new WritableStream() },
          onEvent(e) {
            if (e.type === 'progress') {
              observed++;
              if (observed === count) s.stop();
              else
                pending = s
                  .restartInput('primary', { generation: (generation++).toString() })
                  .catch((e) => {
                    controlFailure = e;
                    s.cancel();
                  });
            }
          },
        });
        const r = await s.result;
        await pending;
        if (controlFailure) throw controlFailure;
        expect(observed).toBe(count);
        expect(r.report.inputs[0].committed).toBe(String(count));
        expect(r.report.mappings.length).toBeLessThanOrEqual(4);
        expect(r.report.historyTruncated).toBe(true);
        expect(BigInt(r.report.inputs[0].committedSlot!.generation)).toBeGreaterThan(
          9007199254740992n,
        );
        measurements.push(r.report.peaks);
      }
      expect(measurements[1]).toEqual(measurements[0]);
      expect(measurements[2]).toEqual(measurements[0]);
    } finally {
      await server.close();
    }
  });
  it(`${name} pause remains responsive to delayed resume and stop`, async () => {
    const server = await startFixtureServer(timelineRoutes(clear));
    try {
      for (const action of ['resume', 'stop'] as const) {
        const s = new HlsDownloader({ adapter }).startRecording({
          url: server.origin + '/master.m3u8',
          output: { type: 'writable', writable: new WritableStream() },
        });
        await s.pause();
        await new Promise((r) => setTimeout(r, 30));
        expect(s.state).toBe('paused');
        await s[action]();
        await s.result;
        expect(s.state).toBe('completed');
      }
    } finally {
      await server.close();
    }
  });
}

it('cancels while shared adapter initialization is pending', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const pending = new Promise<void>((resolve) => (release = resolve));
  let invoked = false;
  const adapter = createAdapter({
    ...getInternalAdapter(NodeAdapter),
    name: 'RecordingInitTest',
    async init() {
      entered();
      await pending;
    },
    async runRecording() {
      invoked = true;
      throw Error('must not run');
    },
  });
  const session = new HlsDownloader({ adapter }).startRecording({
    url: 'https://example.test/live',
    output: { type: 'writable', writable: new WritableStream() },
  });
  await started;
  session.cancel();
  await expect(session.result).rejects.toMatchObject({ code: 'ABORTED' });
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(invoked).toBe(false);
});
