import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { timelineCases, timelineRoutes } from './fixtures/timeline';
import { afterAll, expect, it } from 'vitest';
import { encrypted, key, rotated } from './fixtures/subtitle';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { multiTrackRoutes } from './fixtures/multitrack';
import { startFixtureServer, sendText } from './fixtures/http-server';
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
const dir = mkdtempSync(join(tmpdir(), 'hls-subtitle-'));
afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});
const selector = { groupId: 's', name: 'English' };
const collect = () => {
  const chunks: Uint8Array[] = [];
  let closed = false;
  return {
    chunks,
    get closed() {
      return closed;
    },
    stream: new WritableStream<Uint8Array>({
      write(b) {
        chunks.push(b);
      },
      close() {
        closed = true;
      },
    }),
    text: () => Buffer.concat(chunks).toString(),
  };
};
for (const [name, adapter] of [
  ['native', NodeAdapter],
  ['wasm', BrowserAdapter],
] as const) {
  for (const map of [false, true])
    for (const embedded of [false, true])
      it(`${name}: AES WebVTT map=${map} embedded=${embedded}, rotation, sequence IV, duplicates, writable`, async () => {
        const server = await startFixtureServer(encrypted('vod', map));
        try {
          const side = collect(),
            media = collect();
          const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            embeddedAudio: 'keep',
            subtitleTracks: [
              {
                id: 'cc',
                selector,
                embedded,
                sidecar: { type: 'writable', writable: side.stream },
              },
            ],
            output: { type: 'writable', writable: media.stream },
          });
          expect(side.closed).toBe(true);
          expect(media.closed).toBe(true);
          expect(side.text()).toMatch(/^WEBVTT\n\n/);
          expect(side.text().match(/Hello/g)?.length).toBeGreaterThanOrEqual(2);
          expect(side.text()).toContain('End');
          if (embedded)
            checkEmbeddedIntervals(
              Buffer.concat(media.chunks),
              side.text(),
              join(dir, name + '-' + map + '.mp4'),
            );
          expect(result.report.tracks.filter((t) => t.kind === 'subtitle')).toHaveLength(
            embedded ? 1 : 0,
          );
          // MAP and media declare distinct IV/key contexts; repeated MAP reads share its session entry.
          expect(server.requests.filter((r) => r.path === '/key')).toHaveLength(map ? 2 : 1);
          expect(server.requests.some((r) => r.path.startsWith('/cc-ja/'))).toBe(false);
        } finally {
          await server.close();
        }
      });
  for (const mode of ['live', 'event'])
    it(`${name}: ${mode} stop drains sidecar close`, async () => {
      const server = await startFixtureServer(encrypted(mode));
      const side = collect();
      try {
        let done!: () => void;
        const written = new Promise<void>((r) => (done = r));
        const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
          url: server.origin + '/master.m3u8',
          embeddedAudio: 'keep',
          subtitleTracks: [
            {
              id: 'cc',
              selector,
              embedded: false,
              sidecar: { type: 'writable', writable: side.stream },
            },
          ],
          output: {
            type: 'writable',
            writable: new WritableStream({
              write() {
                done();
              },
            }),
          },
        });
        await written;
        session.stop();
        await session.result;
        expect(side.closed).toBe(true);
        expect(side.text()).toContain('Hello');
      } finally {
        await server.close();
      }
    });
  for (const phase of ['write', 'close'])
    it(`${name}: sidecar ${phase} failure prevents success`, async () => {
      const server = await startFixtureServer(encrypted());
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            embeddedAudio: 'keep',
            subtitleTracks: [
              {
                id: 'cc',
                selector,
                sidecar: {
                  type: 'writable',
                  writable: new WritableStream({
                    write() {
                      if (phase === 'write') throw Error('write');
                    },
                    close() {
                      if (phase === 'close') throw Error('close');
                    },
                  }),
                },
              },
            ],
            output: { type: 'writable', writable: new WritableStream() },
          }),
        ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
      } finally {
        await server.close();
      }
    });
  it(`${name}: blocked sidecar cancellation ignores late acknowledgement`, async () => {
    const server = await startFixtureServer(encrypted());
    let entered!: () => void, release!: () => void;
    const pending = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    let closed = false;
    try {
      const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep',
        subtitleTracks: [
          {
            id: 'cc',
            selector,
            sidecar: {
              type: 'writable',
              writable: new WritableStream({
                write() {
                  entered();
                  return gate;
                },
                close() {
                  closed = true;
                },
              }),
            },
          },
        ],
        output: { type: 'writable', writable: new WritableStream() },
      });
      await pending;
      session.cancel();
      await expect(session.result).rejects.toMatchObject({ code: 'ABORTED' });
      release();
      await new Promise((r) => setTimeout(r, 20));
      expect(closed).toBe(false);
    } finally {
      release?.();
      await server.close();
    }
  });
}
for (const resume of [false, true])
  it(`native fixed paths, resume=${resume}, offline completion`, async () => {
    const server = await startFixtureServer(encrypted());
    const path = join(dir, 'fixed-' + resume + '.mp4'),
      textPath = path + '.vtt';
    const options = {
      url: server.origin + '/master.m3u8',
      embeddedAudio: 'keep' as const,
      subtitleTracks: [
        { id: 'cc', selector, embedded: false, sidecar: { type: 'file' as const, path: textPath } },
      ],
      output: { type: 'file' as const, path, format: 'fmp4' as const },
      ...(resume
        ? {
            resume: { directory: path + '.state' },
            decryption: {
              keyResolver: async (r: any) => ({
                key: r.uri.endsWith('rotated') ? rotated : key,
                version: 'v1',
              }),
            },
          }
        : {}),
    };
    try {
      const dl = new HlsDownloader({ adapter: NodeAdapter });
      await dl.downloadMultiTrack(options);
      expect(readFileSync(textPath, 'utf8')).toContain('Hello');
      if (resume) {
        const before = server.requests.length;
        await dl.downloadMultiTrack(options);
        expect(server.requests.length).toBe(before);
        expect(JSON.parse(readFileSync(path + '.state/engine-state.json', 'utf8')).schema).toBe(2);
      }
    } finally {
      await server.close();
    }
  });

for (const format of ['mp4', 'fmp4'] as const)
  it(`joint ${format} recovery validates fresh AES resources, preserves prefixes, resumes exact VTT`, async () => {
    const routes = encrypted();
    const original = routes['/video/segment-01.m4s']!;
    let fail = true;
    routes['/video/segment-01.m4s'] = (req, res) =>
      fail ? res.writeHead(503).end() : original(req, res);
    const server = await startFixtureServer(routes);
    const path = join(dir, 'interrupted-' + format + '.mp4');
    const vtt = path + '.vtt';
    let version = 'v1';
    const options = {
      url: server.origin + '/master.m3u8',
      maxRetry: 0,
      embeddedAudio: 'keep' as const,
      subtitleTracks: [
        { id: 'cc', selector, embedded: false, sidecar: { type: 'file' as const, path: vtt } },
      ],
      output: { type: 'file' as const, path, format },
      resume: { directory: path + '.state' },
      decryption: {
        keyResolver: async (r: any) => ({
          key: r.uri.endsWith('rotated') ? rotated : key,
          version,
        }),
      },
    };
    const dl = new HlsDownloader({ adapter: NodeAdapter });
    try {
      await expect(dl.downloadMultiTrack(options)).rejects.toMatchObject({
        code: 'SEGMENT_FETCH_FAILED',
      });
      const mediaBefore = readFileSync(path + '.hls-partial'),
        subBefore = readFileSync(vtt + '.hls-partial');
      expect(subBefore.toString()).toContain('Hello');
      fail = false;
      version = 'v2';
      await expect(dl.downloadMultiTrack(options)).rejects.toMatchObject({
        code: 'RESUME_REPLAY_REQUIRED',
      });
      expect(readFileSync(path + '.hls-partial')).toEqual(mediaBefore);
      expect(readFileSync(vtt + '.hls-partial')).toEqual(subBefore);
      version = 'v1';
      await expect(
        dl.downloadMultiTrack({
          ...options,
          subtitleTracks: [
            { ...options.subtitleTracks[0]!, sidecar: { type: 'file', path: vtt + '.changed' } },
          ],
        }),
      ).rejects.toMatchObject({ code: 'RESUME_CONFLICT' });
      const damaged = Buffer.from(subBefore);
      damaged[0] ^= 1;
      writeFileSync(vtt + '.hls-partial', damaged);
      await expect(dl.downloadMultiTrack(options)).rejects.toMatchObject({
        code: 'RESUME_INVALID',
      });
      expect(readFileSync(path + '.hls-partial')).toEqual(mediaBefore);
      expect(readFileSync(vtt + '.hls-partial')).toEqual(damaged);
      writeFileSync(vtt + '.hls-partial', subBefore);
      writeFileSync(
        vtt + '.hls-partial',
        Buffer.concat([subBefore, Buffer.from('uncommitted tail')]),
      );
      await dl.downloadMultiTrack(options);
      const clean = path + '.clean.mp4';
      await dl.downloadMultiTrack({
        ...options,
        resume: undefined,
        output: { type: 'file', path: clean, format },
        subtitleTracks: [
          { id: 'cc', selector, embedded: false, sidecar: { type: 'file', path: clean + '.vtt' } },
        ],
      });
      expect(readFileSync(vtt)).toEqual(readFileSync(clean + '.vtt'));
      expect(existsSync(path)).toBe(true);
      const state = JSON.parse(readFileSync(path + '.state/engine-state.json', 'utf8'));
      expect(state.schema).toBe(2);
      expect(JSON.stringify(state)).not.toContain(key.toString('hex'));
    } finally {
      await server.close();
    }
  });

for (const [name, adapter] of [
  ['native', NodeAdapter],
  ['wasm', BrowserAdapter],
] as const) {
  it(`${name}: finite AES subtitle exports and mapped resource-only export`, async () => {
    const server = await startFixtureServer(encrypted());
    try {
      const dl = new HlsDownloader({ adapter });
      const subtitle = await dl.downloadSubtitles({
        url: server.origin + '/master.m3u8',
        subtitle: selector,
      });
      expect(subtitle.text).toContain('Hello');
      expect(subtitle.totalSegments).toBe(2);
      const media = await dl.downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'exclude',
        output: { type: 'writable', writable: new WritableStream() },
      });
      const before = server.requests.length;
      const mapped = await dl.downloadSubtitleOutputs({
        url: server.origin + '/master.m3u8',
        subtitle: selector,
        timelineMap: media.report.timelineMap!,
        track: { inputId: 'primary', trackId: 1 },
      });
      expect(JSON.stringify(mapped)).toContain('Hello');
      expect(server.requests.slice(before).some((r) => r.path.endsWith('.m4s'))).toBe(false);
      await expect(
        dl.downloadSubtitles({
          url: server.origin + '/master.m3u8',
          subtitle: selector,
          maxBytes: 8,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    } finally {
      await server.close();
    }
  });
  it(`${name}: range excludes cues using committed output clock`, async () => {
    const server = await startFixtureServer(encrypted());
    const side = collect();
    const commits: any[] = [];
    try {
      await new HlsDownloader({ adapter }).downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep',
        onEvent(e) {
          if (e.type === 'subtitleCommit') commits.push(e.commit);
        },
        timeline: {
          range: { start: { ticks: '1', timescale: 5 }, end: { ticks: '1', timescale: 1 } },
        },
        subtitleTracks: [
          { id: 'cc', selector, sidecar: { type: 'writable', writable: side.stream } },
        ],
        output: { type: 'writable', writable: new WritableStream() },
      });
      expect(side.text()).toContain('Hello');
      expect(side.text()).not.toContain('End');
      expect(side.text()).not.toMatch(/--> 00:00:01\.[1-9]/);
      expect(commits.flatMap((c) => c.cues).some((c) => c.disposition === 'RejectedRange')).toBe(
        true,
      );
    } finally {
      await server.close();
    }
  });
  it(`${name}: waits for slow sidecar close and rejects oversized cues`, async () => {
    const server = await startFixtureServer(encrypted());
    let close!: () => void, entered!: () => void;
    const closing = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (close = r));
    let done = false;
    const options = {
      url: server.origin + '/master.m3u8',
      embeddedAudio: 'keep' as const,
      subtitleTracks: [
        {
          id: 'cc',
          selector,
          sidecar: {
            type: 'writable' as const,
            writable: new WritableStream({
              close() {
                entered();
                return gate;
              },
            }),
          },
        },
      ],
      output: { type: 'writable' as const, writable: new WritableStream() },
    };
    try {
      const dl = new HlsDownloader({ adapter });
      const pending = dl.downloadMultiTrack(options).then(() => (done = true));
      await closing;
      expect(done).toBe(false);
      close();
      await pending;
      await expect(
        dl.downloadMultiTrack({
          ...options,
          limits: { sampleBytes: 256 },
          subtitleTracks: [{ id: 'cc', selector }],
          output: { type: 'writable', writable: new WritableStream() },
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    } finally {
      close?.();
      await server.close();
    }
  });
}

for (const [name, adapter] of [
  ['native', NodeAdapter],
  ['wasm', BrowserAdapter],
] as const) {
  for (const method of ['SAMPLE-AES', 'SAMPLE-AES-CTR', 'AES-256-GCM'])
    it(`${name}: rejects ${method} WebVTT explicitly`, async () => {
      const routes = encrypted();
      routes['/cc-en/media.m3u8'] = (_, r) =>
        sendText(
          r,
          `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=${method},URI="../key"\n#EXTINF:1,\none\n#EXT-X-ENDLIST\n`,
        );
      const server = await startFixtureServer(routes);
      try {
        await expect(
          new HlsDownloader({ adapter }).downloadMultiTrack({
            url: server.origin + '/master.m3u8',
            embeddedAudio: 'keep',
            decryption: { experimentalGcm: true },
            subtitleTracks: [{ id: 'cc', selector }],
            output: { type: 'writable', writable: new WritableStream() },
          }),
        ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCRYPTION' });
      } finally {
        await server.close();
      }
    });
  it(`${name}: cancels sidecar factory acquisition and aborts a late writer`, async () => {
    const server = await startFixtureServer(encrypted());
    let entered!: () => void, release!: (s: WritableStream<Uint8Array>) => void;
    const ready = new Promise<void>((r) => (entered = r)),
      gate = new Promise<WritableStream<Uint8Array>>((r) => (release = r));
    let aborted = false;
    try {
      const session = new HlsDownloader({ adapter }).startMultiTrackRecording({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep',
        subtitleTracks: [
          {
            id: 'cc',
            selector,
            sidecar: {
              type: 'writables',
              acquire() {
                entered();
                return gate;
              },
            },
          },
        ],
        output: { type: 'writable', writable: new WritableStream() },
      });
      await ready;
      session.cancel();
      await expect(session.result).rejects.toMatchObject({ code: 'ABORTED' });
      release(
        new WritableStream({
          abort() {
            aborted = true;
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(aborted).toBe(true);
    } finally {
      await server.close();
    }
  });
}

function splitRoutes() {
  const c = structuredClone(timelineCases.find((c) => c.name === 'config-split')!);
  let epoch = 0;
  c.request.primary.text = c.request.primary.text.replace(
    /#EXTINF/g,
    () => '#EXT-X-PROGRAM-DATE-TIME:2026-10-06T00:00:0' + epoch++ * 2 + 'Z\n#EXTINF',
  );
  const timeline = timelineRoutes(c),
    routes = { ...timeline, ...multiTrackRoutes() };
  routes['/video/media.m3u8'] = timeline[new URL(c.request.primary.url).pathname]!;
  routes['/cc-en/media.m3u8'] = (_, res) =>
    sendText(
      res,
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\na.vtt\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nb.vtt\n#EXT-X-ENDLIST\n',
    );
  for (const part of ['a', 'b'])
    routes['/cc-en/' + part + '.vtt'] = (_, res) =>
      sendText(
        res,
        `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:126000\n\n${part}\n00:00.100 --> 00:01.700\npart-${part}\n`,
      );
  return routes;
}
for (const [name, adapter] of [
  ['native', NodeAdapter],
  ['wasm', BrowserAdapter],
] as const)
  it(`${name}: split sidecar factories close each output and rebase cues`, async () => {
    const server = await startFixtureServer(splitRoutes());
    const sides = new Map<string, ReturnType<typeof collect>>();
    try {
      const result = await new HlsDownloader({ adapter }).downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep',
        timeline: { changePolicy: 'split' },
        subtitleTracks: [
          {
            id: 'cc',
            selector,
            embedded: false,
            sidecar: {
              type: 'writables',
              async acquire(r) {
                const side = collect();
                sides.set(r.outputIndex, side);
                return side.stream;
              },
            },
          },
        ],
        output: {
          type: 'writables',
          async acquire() {
            return new WritableStream();
          },
        },
      });
      expect(result.report.outputs).toHaveLength(2);
      expect([...sides.keys()]).toEqual(['0', '1']);
      for (const s of sides.values()) expect(s.closed).toBe(true);
      expect(sides.get('0')!.text()).toContain('part-a');
      expect(sides.get('0')!.text()).not.toContain('part-b');
      expect(sides.get('1')!.text()).toContain('part-b');
      expect(sides.get('1')!.text()).toContain('00:00:00.100');
    } finally {
      await server.close();
    }
  });
for (const format of ['mp4', 'fmp4'] as const)
  it(`native ${format} schema-2 split publishes matching fixed subtitle children`, async () => {
    const server = await startFixtureServer(splitRoutes()),
      path = join(dir, 'split-' + format + '.mp4'),
      vtt = path + '.vtt';
    try {
      const options = {
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep' as const,
        timeline: { changePolicy: 'split' as const },
        subtitleTracks: [
          { id: 'cc', selector, embedded: false, sidecar: { type: 'file' as const, path: vtt } },
        ],
        output: { type: 'file' as const, path, format },
        resume: { directory: path + '.state' },
      };
      const dl = new HlsDownloader({ adapter: NodeAdapter });
      const result = await dl.downloadMultiTrack(options);
      expect(result.report.outputs).toHaveLength(2);
      expect(readFileSync(vtt, 'utf8')).toContain('part-a');
      expect(readFileSync(vtt + '.part-000001.vtt', 'utf8')).toContain('part-b');
      expect(existsSync(vtt + '.hls-partial')).toBe(false);
      const reads = server.requests.length;
      await dl.downloadMultiTrack(options);
      expect(server.requests.length).toBe(reads);
    } finally {
      await server.close();
    }
  });

it('SIGKILL resumes joint media/subtitle prefixes with stable key replay', async () => {
  const routes = encrypted();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  let block = true;
  const original = routes['/video/segment-01.m4s']!;
  routes['/video/segment-01.m4s'] = async (req, res) => {
    if (block) {
      entered();
      await gate;
    }
    return original(req, res);
  };
  const server = await startFixtureServer(routes),
    path = join(dir, 'killed.mp4'),
    vtt = path + '.vtt';
  const options = {
    url: server.origin + '/master.m3u8',
    maxRetry: 0,
    embeddedAudio: 'keep' as const,
    subtitleTracks: [
      { id: 'cc', selector, embedded: false, sidecar: { type: 'file' as const, path: vtt } },
    ],
    output: { type: 'file' as const, path, format: 'fmp4' as const },
    resume: { directory: path + '.state' },
  };
  const script = `const {HlsDownloader}=await import(${JSON.stringify(resolve(import.meta.dirname, '../packages/core/dist/index.mjs'))});const {NodeAdapter}=await import(${JSON.stringify(resolve(import.meta.dirname, '../packages/adapters/dist/node.mjs'))});await new HlsDownloader({adapter:NodeAdapter}).downloadMultiTrack({...${JSON.stringify(options)},decryption:{keyResolver:async r=>({key:Buffer.alloc(16,r.uri.endsWith('rotated')?9:7),version:'v1'})}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (b) => (errors += b));
  const exited = once(child, 'exit');
  try {
    await Promise.race([
      ready,
      exited.then(() => {
        throw Error('child exited: ' + errors);
      }),
    ]);
    expect(readFileSync(vtt + '.hls-partial', 'utf8')).toContain('Hello');
    child.kill('SIGKILL');
    await exited;
    block = false;
    release();
    const dl = new HlsDownloader({ adapter: NodeAdapter });
    await dl.downloadMultiTrack({
      ...options,
      decryption: {
        keyResolver: async (r) => ({
          key: r.uri.endsWith('rotated') ? rotated : key,
          version: 'v1',
        }),
      },
    });
    expect(readFileSync(vtt, 'utf8')).toContain('End');
    expect(existsSync(vtt + '.hls-partial')).toBe(false);
  } finally {
    child.kill('SIGKILL');
    block = false;
    release();
    await server.close();
  }
});

for (const mode of ['live', 'event'])
  it(`native ${mode}: interrupted joint recovery drains on stop`, async () => {
    const routes = encrypted(mode);
    const original = routes['/video/segment-01.m4s']!;
    let fail = true;
    routes['/video/segment-01.m4s'] = (req, res) =>
      fail ? res.writeHead(503).end() : original(req, res);
    const server = await startFixtureServer(routes);
    const path = join(dir, 'recover-' + mode + '.mp4');
    const options = {
      url: server.origin + '/master.m3u8',
      maxRetry: 0,
      embeddedAudio: 'keep' as const,
      subtitleTracks: [
        {
          id: 'cc',
          selector,
          embedded: false,
          sidecar: { type: 'file' as const, path: path + '.vtt' },
        },
      ],
      output: { type: 'file' as const, path, format: 'fmp4' as const },
      resume: { directory: path + '.state' },
      decryption: {
        keyResolver: async (r: any) => ({
          key: r.uri.endsWith('rotated') ? rotated : key,
          version: 'v1',
        }),
      },
    };
    try {
      const dl = new HlsDownloader({ adapter: NodeAdapter });
      await expect(dl.startMultiTrackRecording(options).result).rejects.toMatchObject({
        code: 'SEGMENT_FETCH_FAILED',
      });
      expect(readFileSync(path + '.vtt.hls-partial', 'utf8')).toContain('Hello');
      fail = false;
      let committed!: () => void;
      const ready = new Promise<void>((r) => (committed = r));
      const session = dl.startMultiTrackRecording({
        ...options,
        onEvent(e) {
          if (e.type === 'progress' && BigInt(e.input.committed) >= 2n) committed();
        },
      });
      await Promise.race([ready, session.result]);
      session.stop();
      await session.result;
      const text = readFileSync(path + '.vtt', 'utf8');
      expect(text).toContain('End');
      expect(text.match(/WEBVTT/g)).toHaveLength(1);
      expect(existsSync(path + '.vtt.hls-partial')).toBe(false);
    } finally {
      await server.close();
    }
  });

for (const [name, adapter] of [
  ['native', NodeAdapter],
  ['wasm', BrowserAdapter],
] as const)
  it(`${name}: empty subtitle windows still create and close a valid sidecar`, async () => {
    const routes = multiTrackRoutes('', { subtitle: 'WEBVTT\n\n' });
    const server = await startFixtureServer(routes),
      side = collect();
    try {
      const dl = new HlsDownloader({ adapter });
      await dl.downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep',
        subtitleTracks: [
          {
            id: 'cc',
            selector,
            embedded: false,
            sidecar: { type: 'writable', writable: side.stream },
          },
        ],
        output: { type: 'writable', writable: new WritableStream() },
      });
      expect(side.text()).toBe('WEBVTT\n\n');
      expect(side.closed).toBe(true);
      await expect(
        dl.downloadSubtitles({
          url: server.origin + '/master.m3u8',
          subtitle: selector,
          maxBytes: 4,
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    } finally {
      await server.close();
    }
  });

it('native preserves an existing unrelated subtitle destination', async () => {
  const server = await startFixtureServer(encrypted()),
    path = join(dir, 'existing.mp4'),
    vtt = path + '.vtt';
  writeFileSync(vtt, 'existing subtitles');
  try {
    await expect(
      new HlsDownloader({ adapter: NodeAdapter }).downloadMultiTrack({
        url: server.origin + '/master.m3u8',
        embeddedAudio: 'keep',
        subtitleTracks: [{ id: 'cc', selector, sidecar: { type: 'file', path: vtt } }],
        output: { type: 'file', path },
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
    expect(readFileSync(vtt, 'utf8')).toBe('existing subtitles');
    expect(existsSync(vtt + '.hls-partial')).toBe(false);
  } finally {
    await server.close();
  }
});

/** ffprobe supplies packet boundaries/timestamps; a minimal independent box
 * reader extracts wvtt payloads. Compare multiplicity as well as timing. */
function checkEmbeddedIntervals(bytes: Buffer, text: string, path: string) {
  writeFileSync(path, bytes);
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_packets', '-show_streams', '-of', 'json', path],
      { encoding: 'utf8' },
    ),
  );
  const stream = probe.streams.find((s: any) => s.codec_tag_string === 'wvtt');
  expect(stream).toBeTruthy();
  const embedded: any[] = [];
  function boxes(start: number, end: number, visit: (kind: string, a: number, b: number) => void) {
    for (let i = start; i + 8 <= end;) {
      const size = bytes.readUInt32BE(i);
      expect(size).toBeGreaterThanOrEqual(8);
      expect(i + size).toBeLessThanOrEqual(end);
      visit(bytes.toString('ascii', i + 4, i + 8), i + 8, i + size);
      i += size;
    }
  }
  for (const packet of probe.packets.filter((p: any) => p.stream_index === stream.index)) {
    boxes(Number(packet.pos), Number(packet.pos) + Number(packet.size), (kind, a, b) => {
      if (kind === 'vttc')
        boxes(a, b, (child, c, d) => {
          if (child === 'payl')
            embedded.push([
              bytes.toString('utf8', c, d),
              Math.floor(packet.pts / 90),
              Math.floor((packet.pts + packet.duration) / 90),
            ]);
        });
    });
  }
  const stamp = (s: string) => {
    const [h, m, t] = s.split(':').map(Number);
    return Math.round((h! * 3600 + m! * 60 + t!) * 1000);
  };
  const side = text
    .trim()
    .split(/\n\n/)
    .slice(1)
    .map((block) => {
      const lines = block.split('\n');
      const index = lines.findIndex((l) => l.includes('-->'));
      const m = /^(\S+) --> (\S+)/.exec(lines[index]!)!;
      return [lines.slice(index + 1).join('\n'), stamp(m[1]!), stamp(m[2]!)];
    });
  expect(side.sort()).toEqual(embedded.sort());
}
