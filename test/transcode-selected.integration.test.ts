import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HlsDownloader, HlsDownloaderEvent } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { encryptedRoutes, key } from './fixtures/encrypted';
import { multiTrackRoutes } from './fixtures/multitrack';
import { timelineCases, timelineRoutes, timelineOptions } from './fixtures/timeline';
import { startFixtureServer } from './fixtures/http-server';
const outputs: string[] = [];
const servers: Awaited<ReturnType<typeof startFixtureServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  outputs.splice(0).forEach((p) => rmSync(p, { force: true }));
});
function probe(path: string) {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {
      encoding: 'utf8',
    }),
  );
}
function filename(ext = 'mp4') {
  const name = `selected-${randomUUID()}`;
  outputs.push(resolve(`${name}.${ext}`));
  return name;
}
for (const preset of ['h264', 'hevc', 'vp9'] as const)
  for (const format of ['ts', 'fmp4'])
    it(`${preset}: AES-128 ${format} selected audio, encrypted MAP and range`, async () => {
      const server = await startFixtureServer(encryptedRoutes(format, true, true));
      servers.push(server);
      const requests: string[] = [];
      const d = new HlsDownloader({ adapter: NodeAdapter });
      const result = await d.download({
        url: server.origin + '/master.m3u8',
        filename: filename(preset === 'vp9' ? 'webm' : 'mp4'),
        audio: { groupId: 'a', name: 'en' },
        transcode: { preset },
        timeline: {
          range: {
            start: { ticks: '200', timescale: 1000 },
            end: { ticks: '1200', timescale: 1000 },
          },
        },
        decryption: {
          keyResolver: async (r) => {
            requests.push(r.inputId);
            return { key };
          },
        },
      });
      const p = probe(result.filePath);
      expect(p.streams.map((s: any) => s.codec_name)).toEqual(
        preset === 'vp9' ? ['vp9', 'opus'] : [preset === 'h264' ? 'h264' : 'hevc', 'aac'],
      );
      expect(new Set(requests)).toEqual(new Set(['primary', 'audio']));
      expect(Number(p.format.duration)).toBeGreaterThan(0.8);
      // Engine expands this range to the decodable two-second boundary.
      expect(Number(p.format.duration)).toBeCloseTo(2, 1);
      expect(result.report).toBeUndefined();
      const starts = p.streams.map((s: any) => Number(s.start_time));
      expect(Math.abs(starts[1] - starts[0])).toBeLessThan(0.03);
      const pcm = execFileSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        result.filePath,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-f',
        's16le',
        '-',
      ]);
      const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
      let crossings = 0;
      for (let i = 1; i < samples.length; i++)
        if (samples[i - 1]! <= 0 && samples[i]! > 0) crossings++;
      // Selected fixture audio is 880 Hz; the replaced embedded track is 440 Hz.
      expect(crossings / (samples.length / 48000)).toBeGreaterThan(800);
      expect(crossings / (samples.length / 48000)).toBeLessThan(960);
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', result.filePath, '-f', 'null', '-']);
    });
for (const selection of [undefined, { groupId: 'a', name: 'Japanese' }])
  it(`transcodes ${selection ? 'explicit' : 'default'} audio without fetching other renditions`, async () => {
    const server = await startFixtureServer(multiTrackRoutes());
    servers.push(server);
    const d = new HlsDownloader({ adapter: NodeAdapter });
    await d.download({
      url: server.origin + '/master.m3u8',
      filename: filename(),
      audio: selection,
      transcode: { preset: 'h264' },
    });
    const paths = server.requests.map((r) => r.path);
    expect(paths.some((p) => p.startsWith(selection ? '/ja/' : '/en/'))).toBe(true);
    expect(paths.some((p) => p.startsWith(selection ? '/en/' : '/ja/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('/cc-'))).toBe(false);
  });
for (const c of timelineCases.filter((c) => c.name.startsWith('sample-') && !c.selection.split))
  it(`transcodes ${c.name} through the Engine`, async () => {
    const server = await startFixtureServer(timelineRoutes(c));
    servers.push(server);
    const result = await new HlsDownloader({ adapter: NodeAdapter }).download({
      url: server.origin + '/master.m3u8',
      filename: filename(),
      ...timelineOptions(c),
      transcode: { preset: 'h264' },
    });
    expect(result.totalSegments).toBeGreaterThan(0);
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', result.filePath, '-f', 'null', '-']);
  });
it('does not replace an existing destination and removes staging on failure', async () => {
  const server = await startFixtureServer(multiTrackRoutes());
  servers.push(server);
  const d = new HlsDownloader({ adapter: NodeAdapter });
  const options = {
    url: server.origin + '/master.m3u8',
    filename: filename(),
    transcode: { preset: 'h264' as const },
  };
  const first = await d.download(options),
    before = readFileSync(first.filePath);
  const staging = readdirSync('.').filter((p) =>
    p.startsWith(`.hls-transcode-${options.filename}.mp4-`),
  );
  await expect(d.download(options)).rejects.toMatchObject({ code: 'OUTPUT_WRITE_FAILED' });
  expect(readFileSync(first.filePath)).toEqual(before);
  expect(
    readdirSync('.').filter((p) => p.startsWith(`.hls-transcode-${options.filename}.mp4-`)),
  ).toEqual(staging);
});
it('rejects recovery and split before media acquisition', async () => {
  const d = new HlsDownloader({ adapter: NodeAdapter });
  for (const unsupported of [
    { resume: { directory: '/unused' } },
    { timeline: { changePolicy: 'split' } },
  ])
    await expect(
      d.download({
        url: 'http://127.0.0.1:1/unused',
        filename: filename(),
        transcode: { preset: 'h264' },
        ...unsupported,
      } as any),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
});

it('cancellation after Engine preparation removes staging without publishing or announcing ready', async () => {
  const server = await startFixtureServer(multiTrackRoutes());
  servers.push(server);
  const controller = new AbortController();
  let ready = false;
  const name = filename();
  const d = new HlsDownloader({
    adapter: NodeAdapter,
    onEvent(event) {
      if (event === HlsDownloaderEvent.STITCHING_SEGMENTS) controller.abort();
      if (event === HlsDownloaderEvent.READY_FOR_DOWNLOAD) ready = true;
    },
  });
  await expect(
    d.download({
      url: server.origin + '/master.m3u8',
      filename: name,
      transcode: { preset: 'h264' },
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: 'ABORTED' });
  expect(ready).toBe(false);
  expect(existsSync(resolve(name + '.mp4'))).toBe(false);
  expect(readdirSync('.').filter((p) => p.startsWith('.hls-transcode-' + name + '.mp4-'))).toEqual(
    [],
  );
});
