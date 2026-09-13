import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { getInternalAdapter } from '../packages/shared/src/utils';
import { HlsDownloaderErrorCode } from '../packages/shared/src/index';
import { sendBytes, sendRange, sendText, startFixtureServer } from './fixtures/http-server';
import {
  alternateRenditionMaster,
  emptyMaster,
  encryptedPlaylist,
  unsupportedMediaScenarios,
} from './fixtures/protocol-scenarios';

const fixture = (path: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures/media', path));
const servers: Array<{ close(): Promise<void> }> = [];
const outputs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const path of outputs.splice(0)) rmSync(path, { force: true });
  NodeAdapter.clearCache?.();
});

function probe(path: string) {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration',
      '-show_entries',
      'stream=index,codec_name,codec_type',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    const bytes = readFileSync(path);
    throw new Error(
      `${result.stderr || 'ffprobe failed'}\noutput bytes=${bytes.byteLength}, boxes=${
        bytes
          .toString('latin1')
          .match(/ftyp|moov|moof|mdat/g)
          ?.join(',') ?? 'none'
      }`,
    );
  }
  return JSON.parse(result.stdout) as {
    streams: Array<{ codec_name: string; codec_type: string }>;
    format: { format_name: string; duration: string };
  };
}

function expectMonotonicTimestamps(path: string) {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_packets',
      '-show_entries',
      'packet=stream_index,dts_time,pts_time',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr || 'ffprobe packet scan failed');
  const packets = JSON.parse(result.stdout).packets as Array<{
    stream_index: number;
    dts_time?: string;
    pts_time?: string;
  }>;
  for (const field of ['dts_time', 'pts_time'] as const) {
    const latest = new Map<number, number>();
    for (const packet of packets) {
      if (packet[field] === undefined) continue;
      const current = Number(packet[field]);
      expect(current).toBeGreaterThanOrEqual(latest.get(packet.stream_index) ?? -Infinity);
      latest.set(packet.stream_index, current);
    }
  }
}

describe('NodeAdapter protocol contract', () => {
  it('publishes the tested native capability contract', () => {
    const capabilities = getInternalAdapter(NodeAdapter).capabilities;
    const evidence = {
      download: 'deterministic TS output',
      stream: 'BYTERANGE and EXT-X-MAP stream output',
      configurableRetry: 'transient BYTERANGE retry',
      byteRange: 'recorded Range requests',
      persistentOutput: 'download file ffprobe contract',
      transcodePresets: 'node-adapter-transcode suite',
    } as const;
    for (const key of [
      'download',
      'stream',
      'configurableRetry',
      'byteRange',
      'persistentOutput',
    ] as const) {
      if (capabilities[key] === true) expect(evidence[key]).toBeTruthy();
    }
    for (const preset of capabilities.transcodePresets) {
      expect(evidence.transcodePresets, preset).toBeTruthy();
    }
    expect(capabilities.aes128).toBe(false);
    expect(capabilities.liveRecording).toBe(false);
  });

  it('downloads a deterministic H.264/AAC fixture and produces valid MP4', async () => {
    const playlist = fixture('ts/media.m3u8').toString('utf8');
    const server = await startFixtureServer({
      '/media.m3u8': (_request, response) => sendText(response, playlist),
      '/segment-00.ts': (_request, response) => sendBytes(response, fixture('ts/segment-00.ts')),
      '/segment-01.ts': (_request, response) => sendBytes(response, fixture('ts/segment-01.ts')),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    const result = await downloader.download({
      url: `${server.origin}/media.m3u8`,
      filename: `native-${randomUUID()}`,
    });
    outputs.push(result.filePath);
    const metadata = probe(result.filePath);
    expect(metadata.format.format_name).toContain('mp4');
    expect(Number(metadata.format.duration)).toBeGreaterThan(1.8);
    expect(metadata.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual(
      expect.arrayContaining([
        ['video', 'h264'],
        ['audio', 'aac'],
      ]),
    );
    expectMonotonicTimestamps(result.filePath);
  });

  it('uses Range requests and streams a complete fMP4 result', async () => {
    const playlist = fixture('byterange/media.m3u8').toString('utf8');
    const media = fixture('byterange/media.ts');
    let failed = false;
    const server = await startFixtureServer({
      '/media.m3u8': (_request, response) => sendText(response, playlist),
      '/media.ts': (request, response) => {
        if (!failed && request.headers.range === 'bytes=31772-62415') {
          failed = true;
          response.writeHead(503).end('retry range');
          return;
        }
        sendRange(request, response, media);
      },
    });
    servers.push(server);
    const chunks: Uint8Array[] = [];
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await downloader.downloadToStream(
      { url: `${server.origin}/media.m3u8`, maxRetry: 2 },
      (bytes) => chunks.push(bytes.slice()),
    );
    const path = resolve(process.cwd(), `native-stream-${randomUUID()}.mp4`);
    writeFileSync(path, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    outputs.push(path);
    expect(probe(path).streams.map((stream) => stream.codec_name)).toEqual(
      expect.arrayContaining(['h264', 'aac']),
    );
    expect(
      server.requests
        .filter((request) => request.path === '/media.ts')
        .every((request) => typeof request.headers.range === 'string'),
    ).toBe(true);
    expect(
      server.requests.filter((request) => request.headers.range === 'bytes=31772-62415'),
    ).toHaveLength(2);
    expectMonotonicTimestamps(path);
  });

  it('streams an EXT-X-MAP fixture into a valid fMP4 result', async () => {
    const playlist = fixture('fmp4/media.m3u8').toString('utf8');
    const server = await startFixtureServer({
      '/media.m3u8': (_request, response) => sendText(response, playlist),
      '/init.mp4': (_request, response) => sendBytes(response, fixture('fmp4/init.mp4')),
      '/segment-00.m4s': (_request, response) =>
        sendBytes(response, fixture('fmp4/segment-00.m4s')),
      '/segment-01.m4s': (_request, response) =>
        sendBytes(response, fixture('fmp4/segment-01.m4s')),
    });
    servers.push(server);
    const chunks: Uint8Array[] = [];
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await downloader.downloadToStream({ url: `${server.origin}/media.m3u8` }, (bytes) =>
      chunks.push(bytes.slice()),
    );
    const path = resolve(process.cwd(), `native-fmp4-${randomUUID()}.mp4`);
    writeFileSync(path, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    outputs.push(path);
    expect(probe(path).streams.map((stream) => stream.codec_name)).toEqual(
      expect.arrayContaining(['h264', 'aac']),
    );
    expectMonotonicTimestamps(path);
  });

  it.each(['AES-128', 'SAMPLE-AES'])('rejects %s before media requests', async (method) => {
    const server = await startFixtureServer({
      '/encrypted.m3u8': (_request, response) =>
        sendText(response, encryptedPlaylist(method as 'AES-128' | 'SAMPLE-AES')),
      '/segment.ts': (_request, response) => sendBytes(response, new Uint8Array([1])),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await expect(
      downloader.download({ url: `${server.origin}/encrypted.m3u8` }),
    ).rejects.toMatchObject({
      code: HlsDownloaderErrorCode.UNSUPPORTED_ENCRYPTION,
    });
    expect(server.attempts.get('/segment.ts')).toBeUndefined();
  });

  it.each(unsupportedMediaScenarios)(
    'rejects native %s playlists before fetching media',
    async (_name, manifest) => {
      const server = await startFixtureServer({
        '/media.m3u8': (_request, response) => sendText(response, manifest),
        '/segment.ts': (_request, response) => sendBytes(response, new Uint8Array([1])),
      });
      servers.push(server);
      const downloader = new HlsDownloader({ adapter: NodeAdapter });
      await expect(
        downloader.download({ url: `${server.origin}/media.m3u8` }),
      ).rejects.toMatchObject({
        code: HlsDownloaderErrorCode.TRANSMUX_FAILED,
      });
      expect(server.attempts.get('/segment.ts')).toBeUndefined();
    },
  );

  it('rejects native alternate renditions before selecting one track', async () => {
    const server = await startFixtureServer({
      '/master.m3u8': (_request, response) => sendText(response, alternateRenditionMaster),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await expect(
      downloader.download({ url: `${server.origin}/master.m3u8` }),
    ).rejects.toMatchObject({
      code: HlsDownloaderErrorCode.TRANSMUX_FAILED,
    });
    expect(server.attempts.get('/video.m3u8')).toBeUndefined();
  });

  it('reports a native empty master as NO_VARIANT', async () => {
    const server = await startFixtureServer({
      '/empty.m3u8': (_request, response) => sendText(response, emptyMaster),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await expect(downloader.download({ url: `${server.origin}/empty.m3u8` })).rejects.toMatchObject(
      { code: HlsDownloaderErrorCode.NO_VARIANT },
    );
  });

  it.each([
    ['invalid manifest', '/invalid.m3u8', 'not an HLS manifest'],
    ['cyclic master', '/cycle.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\ncycle.m3u8\n'],
  ])('rejects a native %s as MANIFEST_INVALID', async (_name, path, manifest) => {
    const server = await startFixtureServer({
      [path]: (_request, response) => sendText(response, manifest),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: NodeAdapter });
    await expect(downloader.download({ url: `${server.origin}${path}` })).rejects.toMatchObject({
      code: HlsDownloaderErrorCode.MANIFEST_INVALID,
    });
  });
});
