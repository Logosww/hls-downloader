import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID, createCipheriv } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { HlsDownloaderEvent } from '../packages/shared/src/index';
import { timelineCases, timelineRoutes } from './fixtures/timeline';
import { sendBytes, sendRange, sendText, startFixtureServer } from './fixtures/http-server';

const directories: string[] = [];
const outputs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const media = (name: string) => readFileSync(resolve(import.meta.dirname, 'fixtures/media', name));
function job() {
  const directory = mkdtempSync(join(tmpdir(), 'hls-resume-test-'));
  directories.push(directory);
  const filename = `resume-${randomUUID()}`;
  outputs.push(resolve(`${filename}.mp4`));
  return { filename, resume: { directory }, maxRetry: 1, downloadConcurrency: 1 };
}
function longTs() {
  const directory = mkdtempSync(join(tmpdir(), 'hls-resume-media-'));
  directories.push(directory);
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '6',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '10',
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_list_size',
      '0',
      '-hls_segment_filename',
      join(directory, '%d.ts'),
      join(directory, 'media.m3u8'),
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return {
    playlist: readFileSync(join(directory, 'media.m3u8'), 'utf8'),
    segments: Array.from({ length: 6 }, (_, i) => readFileSync(join(directory, `${i}.ts`))),
  };
}
function state(directory: string) {
  return JSON.parse(readFileSync(join(directory, 'engine-state.json'), 'utf8'));
}
async function fixture(kind: 'ts' | 'fmp4' | 'byterange' = 'ts') {
  let fail = false;
  let manifest = media(`${kind}/media.m3u8`).toString();
  const server = await startFixtureServer({
    '/media.m3u8': (_, res) => sendText(res, manifest),
    '/segment-00.ts': (_, res) => sendBytes(res, media('ts/segment-00.ts')),
    '/segment-01.ts': (_, res) =>
      fail ? res.writeHead(503).end() : sendBytes(res, media('ts/segment-01.ts')),
    '/init.mp4': (_, res) => sendBytes(res, media('fmp4/init.mp4')),
    '/segment-00.m4s': (_, res) => sendBytes(res, media('fmp4/segment-00.m4s')),
    '/segment-01.m4s': (_, res) =>
      fail ? res.writeHead(503).end() : sendBytes(res, media('fmp4/segment-01.m4s')),
    '/media.ts': (req, res) =>
      fail && req.headers.range !== 'bytes=0-31771'
        ? res.writeHead(503).end()
        : sendRange(req, res, media('byterange/media.ts')),
  });
  servers.push(server);
  return {
    ...server,
    url: `${server.origin}/media.m3u8`,
    fail(value: boolean) {
      fail = value;
    },
    manifest(value: string) {
      manifest = value;
    },
  };
}
function probe(file: string) {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-show_packets', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout);
  const times = new Map<number, number>();
  for (const packet of parsed.packets) {
    if (packet.dts_time === undefined) continue;
    const dts = Number(packet.dts_time);
    expect(dts).toBeGreaterThanOrEqual(times.get(packet.stream_index) ?? -Infinity);
    times.set(packet.stream_index, dts);
  }
  return {
    codecs: parsed.streams.map((s: any) => [s.codec_type, s.codec_name]),
    duration: Number(parsed.format.duration),
  };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  directories.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
  outputs.splice(0).forEach((p) => {
    rmSync(p, { force: true });
    rmSync(p + '.hls-partial', { force: true });
  });
});

describe('Node Engine schema-2 recovery', () => {
  for (const kind of ['ts', 'fmp4', 'byterange'] as const)
    it(`replays ${kind} after interrupted resource acquisition`, async () => {
      const server = await fixture(kind),
        options = { ...job(), url: server.url, headers: { Authorization: 'test-secret' } };
      const d = new HlsDownloader({ adapter: NodeAdapter });
      server.fail(true);
      await expect(d.download(options)).rejects.toMatchObject({ code: 'SEGMENT_FETCH_FAILED' });
      const saved = state(options.resume.directory);
      expect(saved.schema).toBe(2);
      expect(saved.checkpoint.schema_version).toBe(2);
      expect(JSON.stringify(saved)).not.toContain('test-secret');
      server.fail(false);
      const result = await d.download(options);
      expect(result.report!.inputs[0]!.committed).toBe('2');
      expect(probe(result.filePath).duration).toBeGreaterThan(1);
      expect(state(options.resume.directory).journal).toEqual([]);
      expect(existsSync(result.filePath + '.hls-partial')).toBe(false);
      const count = server.requests.length;
      expect((await d.download(options)).report!.inputs[0]!.committed).toBe('2');
      expect(server.requests.length).toBe(count);
    });
  it.each(['schema1', 'corrupt', 'missing-replay', 'configuration', 'prefix', 'destination'])(
    'preserves existing bytes on %s failure',
    async (reason) => {
      const server = await fixture(),
        options = { ...job(), url: server.url },
        d = new HlsDownloader({ adapter: NodeAdapter });
      server.fail(true);
      await expect(d.download(options)).rejects.toBeDefined();
      const statePath = join(options.resume.directory, 'engine-state.json');
      const partial = resolve(options.filename + '.mp4.hls-partial');
      if (reason === 'schema1') {
        rmSync(statePath);
        writeFileSync(join(options.resume.directory, 'state.json'), '{}');
      }
      if (reason === 'corrupt') writeFileSync(statePath, 'broken');
      if (reason === 'missing-replay') {
        const s = state(options.resume.directory);
        s.journal = [];
        writeFileSync(statePath, JSON.stringify(s));
      }
      if (reason === 'prefix') {
        server.fail(false);
        const result = await d.download(options);
        const b = readFileSync(result.filePath);
        b[0] ^= 1;
        writeFileSync(result.filePath, b);
      }
      if (reason === 'destination') writeFileSync(resolve(options.filename + '.mp4'), 'unrelated');
      const protectedPath = reason === 'prefix' ? resolve(options.filename + '.mp4') : partial;
      const before = readFileSync(protectedPath);
      server.fail(false);
      const result = await d
        .download({
          ...options,
          ...(reason === 'configuration' ? { timeline: { gapPolicy: 'collapse' as const } } : {}),
        })
        .catch((e) => e);
      expect(result.code).toBe(
        reason === 'configuration' || reason === 'destination'
          ? 'RESUME_CONFLICT'
          : reason === 'missing-replay'
            ? 'RESUME_REPLAY_REQUIRED'
            : 'RESUME_INVALID',
      );
      expect(readFileSync(protectedPath)).toEqual(before);
      if (reason === 'destination')
        expect(readFileSync(resolve(options.filename + '.mp4'), 'utf8')).toBe('unrelated');
    },
  );
  it('truncates an uncommitted tail only after successful replay validation', async () => {
    const server = await fixture(),
      options = { ...job(), url: server.url },
      d = new HlsDownloader({ adapter: NodeAdapter });
    server.fail(true);
    await expect(d.download(options)).rejects.toBeDefined();
    const partial = resolve(options.filename + '.mp4.hls-partial');
    writeFileSync(partial, Buffer.concat([readFileSync(partial), Buffer.from('uncommitted')]));
    server.fail(false);
    const result = await d.download(options);
    expect(probe(result.filePath).duration).toBeGreaterThan(1);
  });
  it('holds a kernel lock until cancellation and permits a fresh owner', async () => {
    const server = await fixture(),
      options = { ...job(), url: server.url };
    const controller = new AbortController();
    let entered!: () => void;
    const gate = new Promise<void>((r) => (entered = r));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/segment-00.ts')) {
        entered();
        await new Promise((_, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          }),
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const task = new HlsDownloader({ adapter: NodeAdapter }).download({
        ...options,
        signal: controller.signal,
      });
      const rejected = expect(task).rejects.toMatchObject({ code: 'ABORTED' });
      await gate;
      await expect(
        new HlsDownloader({ adapter: NodeAdapter }).download(options),
      ).rejects.toMatchObject({ code: 'RESUME_CONFLICT' });
      controller.abort();
      await rejected;
    } finally {
      globalThis.fetch = originalFetch;
      controller.abort();
    }
    expect(
      (await new HlsDownloader({ adapter: NodeAdapter }).download(options)).report!.inputs[0]!
        .committed,
    ).toBe('2');
  });
  it('propagates checkpoint persistence failure independently of observers', async () => {
    const server = await fixture(),
      options = { ...job(), url: server.url };
    const originalFetch = globalThis.fetch;
    let replaced = false;
    globalThis.fetch = (async (input, init) => {
      if (!replaced && String(input).endsWith('/segment-00.ts')) {
        replaced = true;
        const path = join(options.resume.directory, 'engine-state.json');
        rmSync(path);
        mkdirSync(path);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await expect(
        new HlsDownloader({ adapter: NodeAdapter, onEvent() {} }).download(options),
      ).rejects.toMatchObject({ code: 'RESUME_IO_FAILED' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

it('recovers a committed task after SIGKILL releases the directory lock', async () => {
  const media = longTs();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  let blocked = true;
  const server = await startFixtureServer({
    '/media.m3u8': (_, res) => sendText(res, media.playlist),
    ...(Object.fromEntries(
      media.segments.map((data, i) => [
        '/' + i + '.ts',
        async (_, res) => {
          if (i === 3 && blocked) {
            entered();
            await gate;
          }
          sendBytes(res, data);
        },
      ]),
    ) as any),
  });
  servers.push(server);
  const options = { ...job(), url: server.origin + '/media.m3u8' };
  const core = resolve(import.meta.dirname, '../packages/core/dist/index.mjs');
  const adapter = resolve(import.meta.dirname, '../packages/adapters/dist/node.mjs');
  const script = `const {HlsDownloader}=await import(${JSON.stringify(core)});const {NodeAdapter}=await import(${JSON.stringify(adapter)});await new HlsDownloader({adapter:NodeAdapter}).download(${JSON.stringify(options)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  try {
    await Promise.race([
      ready,
      exited.then(() => {
        throw Error('child exited before committed checkpoint');
      }),
    ]);
    child.kill('SIGKILL');
    await exited;
    blocked = false;
    release();
    const partial = resolve(options.filename + '.mp4.hls-partial');
    expect(readFileSync(partial).length).toBeGreaterThan(1000);
    const result = await new HlsDownloader({ adapter: NodeAdapter }).download(options);
    expect(result.report!.inputs[0]!.committed).toBe('6');
    expect(probe(result.filePath).duration).toBeGreaterThan(5);
  } finally {
    child.kill('SIGKILL');
    blocked = false;
    release();
  }
});
it('requires a stable encrypted recovery version and preserves a committed prefix on change', async () => {
  const source = longTs(),
    key = Buffer.alloc(32, 7),
    iv = Buffer.alloc(16, 3);
  const encrypted = source.segments.map((data) => {
    const c = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]);
  });
  let fail = true;
  const server = await startFixtureServer({
    '/media.m3u8': (_, res) =>
      sendText(
        res,
        source.playlist.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-256-GCM,URI="key"'),
      ),
    ...(Object.fromEntries(
      encrypted.map((data, i) => [
        '/' + i + '.ts',
        (_, res) => (i === 3 && fail ? res.writeHead(503).end() : sendBytes(res, data)),
      ]),
    ) as any),
  });
  servers.push(server);
  const options = {
    ...job(),
    url: server.origin + '/media.m3u8',
    decryption: { experimentalGcm: true, keyResolver: async () => ({ key, version: 'version-a' }) },
  };
  const d = new HlsDownloader({ adapter: NodeAdapter });
  await expect(d.download(options)).rejects.toMatchObject({ code: 'SEGMENT_FETCH_FAILED' });
  const partial = resolve(options.filename + '.mp4.hls-partial'),
    before = readFileSync(partial);
  expect(before.length).toBeGreaterThan(1000);
  expect(readFileSync(join(options.resume.directory, 'engine-state.json'), 'utf8')).not.toContain(
    key.toString('hex'),
  );
  fail = false;
  const conflict = await d
    .download({
      ...options,
      decryption: {
        experimentalGcm: true,
        keyResolver: async () => ({ key, version: 'version-b' }),
      },
    })
    .catch((e) => e);
  expect(conflict.code).toBe('RESUME_CONFLICT');
  expect(readFileSync(partial)).toEqual(before);
  expect((await d.download(options)).report!.inputs[0]!.committed).toBe('6');
});

it('requires subtitle replay receipts before modifying a recovered output', async () => {
  const source = longTs();
  let fail = true;
  const server = await startFixtureServer({
    '/master.m3u8': (_, res) =>
      sendText(
        res,
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="cc.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,SUBTITLES="s"\nmedia.m3u8\n',
      ),
    '/media.m3u8': (_, res) => sendText(res, source.playlist),
    '/cc.m3u8': (_, res) =>
      sendText(res, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\ntext.vtt\n#EXT-X-ENDLIST\n'),
    '/text.vtt': (_, res) =>
      sendText(
        res,
        'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:126000\n\none\n00:00.100 --> 00:00.900\nHello\n\ntwo\n00:03.100 --> 00:04.000\nLater\n',
      ),
    ...(Object.fromEntries(
      source.segments.map((data, i) => [
        '/' + i + '.ts',
        (_, res) => (i === 3 && fail ? res.writeHead(503).end() : sendBytes(res, data)),
      ]),
    ) as any),
  });
  servers.push(server);
  const options = job(),
    path = resolve(options.filename + '.mp4');
  const config = {
    url: server.origin + '/master.m3u8',
    embeddedAudio: 'keep' as const,
    subtitleTracks: [{ id: 'cc', selector: { groupId: 's', name: 'English' } }],
    output: { type: 'file' as const, path },
    resume: options.resume,
    maxRetry: 0,
  };
  const d = new HlsDownloader({ adapter: NodeAdapter });
  await expect(d.downloadMultiTrack(config)).rejects.toMatchObject({
    code: 'SEGMENT_FETCH_FAILED',
  });
  const checkpoint = state(options.resume.directory);
  const original = JSON.stringify(checkpoint);
  expect(checkpoint.journal.some((c: any) => c.action === 'initialText')).toBe(true);
  checkpoint.journal = checkpoint.journal.filter(
    (c: any) => !['initialCues', 'cues', 'tryCues', 'initialText', 'text', 'tryText'].includes(c.action),
  );
  const statePath = join(options.resume.directory, 'engine-state.json');
  writeFileSync(statePath, JSON.stringify(checkpoint));
  const before = readFileSync(path + '.hls-partial');
  fail = false;
  await expect(d.downloadMultiTrack(config)).rejects.toMatchObject({
    code: 'RESUME_REPLAY_REQUIRED',
  });
  expect(readFileSync(path + '.hls-partial')).toEqual(before);
  writeFileSync(statePath, original);
  expect((await d.downloadMultiTrack(config)).report.subtitleReports.length).toBeGreaterThan(0);
});

it('restores all published split files offline with fixed Engine part names', async () => {
  const c = timelineCases.find((c) => c.name === 'config-split');
  const server = await startFixtureServer(timelineRoutes(c));
  servers.push(server);
  const options = job(),
    path = resolve(options.filename + '.mp4'),
    part = path + '.part-000001.mp4';
  outputs.push(part);
  const config = {
    url: server.origin + '/master.m3u8',
    output: { type: 'file' as const, path },
    resume: options.resume,
    timeline: { changePolicy: 'split' as const },
  };
  const d = new HlsDownloader({ adapter: NodeAdapter });
  const result = await d.startRecording(config).result;
  expect(result.report.outputs.map((o) => o.filePath)).toEqual([path, part]);
  const before = [readFileSync(path), readFileSync(part)];
  await server.close();
  servers.pop();
  for (let i = 0; i < 2; i++) {
    const r = await d.startRecording(config).result;
    expect(r.report.outputs.map((o) => o.filePath)).toEqual([path, part]);
    expect([readFileSync(path), readFileSync(part)]).toEqual(before);
  }
  writeFileSync(part, 'conflicting published file');
  const corrupted = await d.startRecording(config).result.catch((e) => e);
  expect(corrupted.code).toBe('RESUME_INVALID');
  expect(corrupted.completedOutputs.map((o: any) => o.filePath)).toEqual([path, part]);
  expect(readFileSync(path)).toEqual(before[0]);
  expect(readFileSync(part, 'utf8')).toBe('conflicting published file');
});

it.each(['fail', 'skip', 'split'] as const)(
  'restores an evicted recording window using %s',
  async (policy) => {
    const source = longTs();
    let resumed = false;
    const header = source.playlist
      .split('#EXTINF')[0]!
      .replace(/#EXT-X-PLAYLIST-TYPE:[^\n]*\n/g, '');
    const pairs = [...source.playlist.matchAll(/#EXTINF:[^\n]*\n[^#\n]+/g)].map((m) => m[0]);
    const window = (start: number, count: number, end: boolean) =>
      header.replace(/#EXT-X-MEDIA-SEQUENCE:\d+/, '#EXT-X-MEDIA-SEQUENCE:' + start) +
      pairs.slice(start, start + count).join('\n') +
      '\n' +
      (end ? '#EXT-X-ENDLIST\n' : '');
    const server = await startFixtureServer({
      '/media.m3u8': (_, res) => sendText(res, resumed ? window(3, 3, true) : window(0, 3, false)),
      ...(Object.fromEntries(
        source.segments.map((data, i) => ['/' + i + '.ts', (_, res) => sendBytes(res, data)]),
      ) as any),
    });
    servers.push(server);
    const options = job(),
      path = resolve(options.filename + '.mp4');
    outputs.push(path + '.part-000001.mp4');
    let session: ReturnType<InstanceType<typeof HlsDownloader>['startRecording']>;
    const config = {
      url: server.origin + '/media.m3u8',
      output: { type: 'file' as const, path },
      resume: options.resume,
      missingSegments: policy,
      maxRetry: 0,
    };
    session = new HlsDownloader({ adapter: NodeAdapter }).startRecording({
      ...config,
      onEvent(e) {
        if (e.type === 'progress' && e.input.committed === '2') session.cancel();
      },
    });
    await expect(session.result).rejects.toMatchObject({ code: 'ABORTED' });
    resumed = true;
    const restored = new HlsDownloader({ adapter: NodeAdapter }).startRecording(config).result;
    if (policy === 'fail')
      await expect(restored).rejects.toMatchObject({ code: 'RESUME_REPLAY_REQUIRED' });
    else {
      const r = await restored;
      expect(BigInt(r.report.gapCount)).toBeGreaterThanOrEqual(1n);
      expect(r.report.inputs[0]!.committed).toBe('6');
      expect(r.report.outputs.length).toBe(policy === 'split' ? 2 : 1);
    }
  },
);
