import { afterEach, describe, expect, it } from 'vitest';
import { HlsDownloader } from '@hls-downloader/core';
import { HlsDownloaderErrorCode } from '@hls-downloader/shared';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { sendBytes, sendText, startFixtureServer } from './fixtures/http-server';

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
segment-0.ts?part=0
#EXTINF:4,
segment-1.ts
#EXTINF:4,
segment-2.ts
#EXT-X-ENDLIST
`;

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  BrowserAdapter.clearCache?.();
});

describe('HTTP HLS integration', () => {
  it('resolves relative variants from the final redirect URL', async () => {
    const server = await startFixtureServer({
      '/entry.m3u8': (_request, response) => {
        response.writeHead(302, { location: '/nested/master.m3u8?source=redirect' }).end();
      },
      '/nested/master.m3u8': (_request, response) => {
        sendText(response, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia.m3u8\n');
      },
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });

    await expect(
      downloader.parseHls({ url: `${server.origin}/entry.m3u8` }),
    ).resolves.toMatchObject({
      type: 'playlist',
      data: [{ uri: `${server.origin}/nested/media.m3u8` }],
    });
    expect(server.requests.some((request) => request.query.get('source') === 'redirect')).toBe(
      true,
    );
  });

  it('follows master/media URLs and forwards headers with bounded concurrency', async () => {
    const server = await startFixtureServer({
      '/master.m3u8': (_request, response) => {
        sendText(
          response,
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360\nmedia/index.m3u8?quality=high\n',
        );
      },
      '/media/index.m3u8': (_request, response) => sendText(response, MEDIA_PLAYLIST),
      '/media/init.mp4': (_request, response) => sendBytes(response, new Uint8Array([0, 1]), 20),
      '/media/segment-0.ts': (request, response) => {
        if (request.attempt === 1) {
          response.writeHead(503).end('retry');
          return;
        }
        return sendBytes(response, new Uint8Array([0, 1, 2]), 20);
      },
      '/media/segment-1.ts': (_request, response) =>
        sendBytes(response, new Uint8Array([3, 4, 5]), 20),
      '/media/segment-2.ts': (_request, response) =>
        sendBytes(response, new Uint8Array([6, 7, 8]), 20),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });

    await expect(
      downloader.download({
        url: `${server.origin}/master.m3u8?token=manifest-secret`,
        headers: { authorization: 'Bearer fixture', 'x-fixture': 'yes' },
        maxRetry: 2,
        downloadConcurrency: 2,
      }),
    ).rejects.toMatchObject({ code: HlsDownloaderErrorCode.TRANSMUX_FAILED });

    expect(server.attempts.get('/media/segment-0.ts')).toBe(2);
    expect(server.peakConcurrency).toBeLessThanOrEqual(2);
    expect(server.requests.some((request) => request.query.get('quality') === 'high')).toBe(true);
    expect(server.requests.some((request) => request.query.get('part') === '0')).toBe(true);
    expect(
      server.requests.every(
        (request) =>
          request.headers.authorization === 'Bearer fixture' &&
          request.headers['x-fixture'] === 'yes',
      ),
    ).toBe(true);
  });

  it('does not retry a non-retryable segment response', async () => {
    const server = await startFixtureServer({
      '/media.m3u8': (_request, response) =>
        sendText(response, '#EXTM3U\n#EXTINF:4,\nmissing.ts\n#EXT-X-ENDLIST\n'),
      '/missing.ts': (_request, response) => response.writeHead(404).end('missing'),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });

    await expect(
      downloader.download({ url: `${server.origin}/media.m3u8`, maxRetry: 4 }),
    ).rejects.toMatchObject({
      code: HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
      status: 404,
      attempt: 1,
    });
    expect(server.attempts.get('/missing.ts')).toBe(1);
  });

  it('cancels an active segment request', async () => {
    const server = await startFixtureServer({
      '/media.m3u8': (_request, response) =>
        sendText(response, '#EXTM3U\n#EXTINF:4,\nslow.ts\n#EXT-X-ENDLIST\n'),
      '/slow.ts': (_request, response) => sendBytes(response, new Uint8Array([1]), 1_000),
    });
    servers.push(server);
    const controller = new AbortController();
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });
    const download = downloader.download({
      url: `${server.origin}/media.m3u8`,
      signal: controller.signal,
      maxRetry: 3,
    });
    setTimeout(() => controller.abort(), 20);

    await expect(download).rejects.toMatchObject({
      name: 'AbortError',
      code: HlsDownloaderErrorCode.ABORTED,
    });
  });
});
