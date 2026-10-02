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
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { HlsDownloaderEvent } from '../packages/shared/src/index';
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
  return JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
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
  outputs.splice(0).forEach((p) => rmSync(p, { force: true }));
});

describe('Node persistent recovery (requires the real native module)', () => {
  for (const kind of ['ts', 'fmp4', 'byterange'] as const) {
    it(`reuses verified ${kind} resources after failure and cleans media after publication`, async () => {
      const server = await fixture(kind);
      const options = { ...job(), url: server.url, headers: { Authorization: 'test-secret' } };
      const errors: unknown[] = [];
      const downloader = new HlsDownloader({
        adapter: NodeAdapter,
        onEvent(event, payload) {
          if (event === HlsDownloaderEvent.ERROR) errors.push(payload.error);
        },
      });
      expect(downloader.capabilities.resumableDownload).toBe(true);
      server.fail(true);
      await expect(downloader.download(options)).rejects.toMatchObject({
        code: 'SEGMENT_FETCH_FAILED',
      });
      expect(errors).toHaveLength(1);
      const cached = readdirSync(join(options.resume.directory, 'cache'));
      expect(cached.some((n) => n.endsWith('.bin'))).toBe(true);
      expect(readFileSync(join(options.resume.directory, 'state.json'), 'utf8')).not.toContain(
        'test-secret',
      );
      const cachedPath =
        kind === 'ts' ? '/segment-00.ts' : kind === 'fmp4' ? '/segment-00.m4s' : '/media.ts';
      const firstCount = server.requests.filter(
        (r) =>
          r.path === cachedPath && (kind !== 'byterange' || r.headers.range === 'bytes=0-31771'),
      ).length;
      server.fail(false);
      const result = await downloader.download(options);
      expect(result.totalSegments).toBe(2);
      expect(
        server.requests.filter(
          (r) =>
            r.path === cachedPath && (kind !== 'byterange' || r.headers.range === 'bytes=0-31771'),
        ).length,
      ).toBe(firstCount);
      expect(readdirSync(join(options.resume.directory, 'cache'))).toEqual([]);
      expect(existsSync(join(options.resume.directory, 'output.partial.mp4'))).toBe(false);
      const resumed = probe(result.filePath);
      const freshOptions = job();
      const fresh = await downloader.download({
        url: options.url,
        filename: freshOptions.filename,
      });
      expect(resumed).toEqual(probe(fresh.filePath));
      const requests = server.requests.length;
      const repeated = await downloader.download(options);
      expect(repeated.filePath).toBe(result.filePath);
      expect(repeated.operationId).not.toBe(result.operationId);
      expect(server.requests).toHaveLength(requests);
    });
  }

  it('recovers implicit byte ranges', async () => {
    const server = await fixture('byterange');
    server.manifest(media('byterange/media.m3u8').toString().replace('30644@31772', '30644'));
    const options = { ...job(), url: server.url };
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    server.fail(true);
    await expect(downloader.download(options)).rejects.toMatchObject({
      code: 'SEGMENT_FETCH_FAILED',
    });
    server.fail(false);
    const result = await downloader.download(options);
    expect(server.requests.filter((r) => r.headers.range === 'bytes=0-31771')).toHaveLength(1);
    expect(server.requests.filter((r) => r.headers.range === 'bytes=31772-62415')).toHaveLength(2);
    expect(probe(result.filePath).duration).toBeGreaterThan(1.8);
  });

  it('keeps MAP and media ranges at the same URL as separate cache resources', async () => {
    const init = media('fmp4/init.mp4'),
      first = media('fmp4/segment-00.m4s'),
      second = media('fmp4/segment-01.m4s');
    const bundle = Buffer.concat([init, first, second]);
    const lastRange = `bytes=${init.length + first.length}-${bundle.length - 1}`;
    const playlist = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="all.mp4",BYTERANGE="${init.length}@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:${first.length}@${init.length}\nall.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:${second.length}\nall.mp4\n#EXT-X-ENDLIST\n`;
    let fail = true;
    const server = await startFixtureServer({
      '/media.m3u8': (_, res) => sendText(res, playlist),
      '/all.mp4': (req, res) =>
        fail && req.headers.range === lastRange
          ? res.writeHead(503).end()
          : sendRange(req, res, bundle),
    });
    servers.push(server);
    const options = { ...job(), url: `${server.origin}/media.m3u8` };
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await expect(downloader.download(options)).rejects.toMatchObject({
      code: 'SEGMENT_FETCH_FAILED',
    });
    fail = false;
    const result = await downloader.download(options);
    expect(
      server.requests.filter((r) => r.headers.range === `bytes=0-${init.length - 1}`),
    ).toHaveLength(1);
    expect(
      server.requests.filter(
        (r) => r.headers.range === `bytes=${init.length}-${init.length + first.length - 1}`,
      ),
    ).toHaveLength(1);
    expect(probe(result.filePath).duration).toBeGreaterThan(1.8);
  });

  it('redownloads a corrupt cache entry and rejects changed identities without destroying state', async () => {
    const server = await fixture();
    server.fail(true);
    const options = { ...job(), url: server.url };
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await expect(downloader.download(options)).rejects.toThrow();
    const saved = readFileSync(join(options.resume.directory, 'state.json'));
    for (const changed of [
      { url: `${server.url}?token=changed` },
      { headers: { Authorization: 'new' } },
      { filename: 'different' },
    ]) {
      await expect(downloader.download({ ...options, ...changed })).rejects.toMatchObject({
        code: 'RESUME_INVALID',
      });
      expect(readFileSync(join(options.resume.directory, 'state.json'))).toEqual(saved);
    }
    const cacheDir = join(options.resume.directory, 'cache');
    writeFileSync(
      join(
        cacheDir,
        readdirSync(cacheDir).find((n) => n.endsWith('.bin'))!,
      ),
      'corrupt',
    );
    server.fail(false);
    await downloader.download(options);
    expect(server.attempts.get('/segment-00.ts')).toBe(2);
  });

  it('refetches manifests and rejects changed content even in the same downloader', async () => {
    const server = await fixture();
    server.fail(true);
    const options = { ...job(), url: server.url };
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await expect(downloader.download(options)).rejects.toThrow();
    server.manifest(
      media('ts/media.m3u8').toString().replace('#EXTINF:1.000000', '#EXTINF:1.100000'),
    );
    server.fail(false);
    await expect(downloader.download(options)).rejects.toMatchObject({ code: 'RESUME_INVALID' });
  });

  it('cancels a checkpointed download, locks concurrent users, and resumes without fetching committed segments', async () => {
    const { playlist, segments } = longTs();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const downloading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let blocked = true;
    const server = await startFixtureServer({
      '/media.m3u8': (_, res) => sendText(res, playlist),
      ...Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `/${i}.ts`,
          async (_: unknown, res: any) => {
            if (i === 3 && blocked) {
              entered();
              await waiting;
            }
            await sendBytes(res, segments[i]!);
          },
        ]),
      ),
    });
    servers.push(server);
    const options = { ...job(), url: `${server.origin}/media.m3u8` };
    const controller = new AbortController();
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    const first = downloader.download({ ...options, signal: controller.signal });
    const settled = first.catch((error) => error);
    await Promise.race([
      downloading,
      first.then(() => {
        throw new Error('Download unexpectedly finished');
      }),
    ]);
    expect(state(options.resume.directory).checkpoint.completed_segments).toBeGreaterThan(0);
    await expect(downloader.download(options)).rejects.toMatchObject({ code: 'RESUME_CONFLICT' });
    const independent = downloader.download({ ...job(), url: options.url });
    controller.abort();
    expect(await settled).toMatchObject({ code: 'ABORTED', name: 'AbortError' });
    blocked = false;
    release();
    expect(probe((await independent).filePath).duration).toBeGreaterThan(5);
    const count = server.attempts.get('/0.ts');
    const result = await downloader.download(options);
    expect(server.attempts.get('/0.ts')).toBe(count);
    expect(probe(result.filePath).duration).toBeGreaterThan(5);
  });

  it('recovers after a process is killed and the OS releases its directory lock', async () => {
    const { playlist, segments } = longTs();
    let blocked = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startFixtureServer({
      '/media.m3u8': (_, res) => sendText(res, playlist),
      ...Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [
          `/${i}.ts`,
          async (_: unknown, res: any) => {
            if (i === 3 && blocked) await gate;
            await sendBytes(res, segments[i]!);
          },
        ]),
      ),
    });
    servers.push(server);
    const options = { ...job(), url: `${server.origin}/media.m3u8` };
    const native = resolve(import.meta.dirname, '../packages/adapters/src/node/native.js');
    const script = `const native = require(${JSON.stringify(native)});
      (async () => {
        const session = await native.openResumeTask(${JSON.stringify(options.resume.directory)}, ${JSON.stringify(JSON.stringify({ url: options.url, headers: [], variant: null }))}, ${JSON.stringify(resolve(`${options.filename}.mp4`))});
        const token = await native.createCancelToken();
        await native.runResumeTask(session.id, ${JSON.stringify(options.url)}, null, 1, 1, token,
          (err, progress) => { if (!err && progress[1] > 0) process.stdout.write('checkpoint\\n'); });
      })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      await Promise.race([
        once(child.stdout!, 'data'),
        exited.then(() => {
          throw new Error('Recovery child exited before checkpoint');
        }),
      ]);
      child.kill('SIGKILL');
      await exited;
      expect(state(options.resume.directory).checkpoint.completed_segments).toBeGreaterThan(0);
      blocked = false;
      release();
      const before = server.attempts.get('/0.ts');
      const result = await new HlsDownloader({ adapter: NodeAdapter }).download(options);
      expect(server.attempts.get('/0.ts')).toBe(before);
      expect(probe(result.filePath).duration).toBeGreaterThan(5);
    } finally {
      child.kill('SIGKILL');
      blocked = false;
      release();
    }
  });

  it('stops on checkpoint I/O failure, retains the last durable state, and recovers after repair', async () => {
    const { playlist, segments } = longTs();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = true;
    const server = await startFixtureServer({
      '/media.m3u8': (_, res) => sendText(res, playlist),
      ...Object.fromEntries(
        segments.map((bytes, i) => [
          `/${i}.ts`,
          async (_: unknown, res: any) => {
            if (i === 3 && blocked) {
              entered();
              await gate;
            }
            await sendBytes(res, bytes);
          },
        ]),
      ),
    });
    servers.push(server);
    const options = { ...job(), url: `${server.origin}/media.m3u8` };
    const events: HlsDownloaderEvent[] = [];
    const downloader = new HlsDownloader({
      adapter: NodeAdapter,
      onEvent(event) {
        events.push(event);
      },
    });
    const pending = downloader.download(options);
    const settled = pending.catch((error) => error);
    try {
      await Promise.race([reached, pending]);
      const path = join(options.resume.directory, 'state.json');
      const saved = readFileSync(path);
      expect(JSON.parse(saved.toString()).checkpoint.completed_segments).toBeGreaterThan(0);
      rmSync(path);
      mkdirSync(path);
      blocked = false;
      release();
      expect(await settled).toMatchObject({ code: 'RESUME_IO_FAILED' });
      expect(events.filter((e) => e === HlsDownloaderEvent.ERROR)).toHaveLength(1);
      expect(events).not.toContain(HlsDownloaderEvent.READY_FOR_DOWNLOAD);
      rmSync(path, { recursive: true });
      writeFileSync(path, saved);
      const result = await downloader.download(options);
      expect(probe(result.filePath).duration).toBeGreaterThan(5);
    } finally {
      blocked = false;
      release();
    }
  });

  it('cancels during manifest resolution before the first checkpoint and can retry', async () => {
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocked = true;
    const server = await startFixtureServer({
      '/media.m3u8': async (_, res) => {
        if (blocked) {
          entered();
          await gate;
        }
        sendText(res, media('ts/media.m3u8').toString());
      },
      '/segment-00.ts': (_, res) => sendBytes(res, media('ts/segment-00.ts')),
      '/segment-01.ts': (_, res) => sendBytes(res, media('ts/segment-01.ts')),
    });
    servers.push(server);
    const options = { ...job(), url: `${server.origin}/media.m3u8` };
    const controller = new AbortController();
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    const pending = downloader.download({ ...options, signal: controller.signal });
    const settled = pending.catch((error) => error);
    try {
      await Promise.race([reached, pending]);
      controller.abort();
      expect(await settled).toMatchObject({ code: 'ABORTED', name: 'AbortError' });
      expect(state(options.resume.directory).checkpoint).toBeNull();
      blocked = false;
      release();
      const result = await downloader.download(options);
      expect(probe(result.filePath).duration).toBeGreaterThan(1.8);
    } finally {
      blocked = false;
      release();
    }
  });

  it('rejects unknown directories and unsupported options before downloading', async () => {
    const options = { ...job(), url: 'http://127.0.0.1:1/unreachable' };
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    writeFileSync(join(options.resume.directory, 'unrelated'), 'keep');
    await expect(downloader.download(options)).rejects.toMatchObject({ code: 'RESUME_INVALID' });
    expect(readdirSync(options.resume.directory)).toEqual(['unrelated']);
    await expect(
      downloader.download({ ...options, transcode: { preset: 'h264' } }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
    await expect(
      downloader.download({ ...options, aria2: { enabled: true } }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
    await expect(downloader.downloadToStream(options, () => {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
    });
  });

  it('preserves invalid metadata and releases the directory lock', async () => {
    const server = await fixture();
    server.fail(true);
    const options = { ...job(), url: server.url };
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await expect(downloader.download(options)).rejects.toThrow();
    // A corrupt metadata file must be rejected, never treated as a new job.
    writeFileSync(join(options.resume.directory, 'state.json'), '{');
    await expect(downloader.download(options)).rejects.toMatchObject({ code: 'RESUME_INVALID' });
    expect(readFileSync(join(options.resume.directory, 'state.json'), 'utf8')).toBe('{');
  });
});
