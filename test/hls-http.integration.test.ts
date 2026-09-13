import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readFile, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HlsDownloader } from '@hls-downloader/core';
import { HlsDownloaderErrorCode } from '@hls-downloader/shared';
import { BrowserAdapter } from '../packages/adapters/src/browser/index';
import { sendBytes, sendRange, sendText, startFixtureServer } from './fixtures/http-server';
import {
  alternateRenditionMaster,
  emptyMaster,
  encryptedPlaylist,
  unsupportedMediaScenarios,
} from './fixtures/protocol-scenarios';

const fixture = (path: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures/media', path));
const platformFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('file:') && url.endsWith('hls_transmux_browser_wasm_bg.wasm')) {
    const wasm = await new Promise<Buffer>((resolveRead, rejectRead) =>
      readFile(
        resolve(
          import.meta.dirname,
          '../packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
        ),
        (error, bytes) => (error ? rejectRead(error) : resolveRead(bytes)),
      ),
    );
    return new Response(wasm, { headers: { 'content-type': 'application/wasm' } });
  }
  return platformFetch(input, init);
}) as typeof fetch;

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

afterAll(() => {
  globalThis.fetch = platformFetch;
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

  it('uses real Range requests for explicit and implicit BYTERANGE segments', async () => {
    const playlist = fixture('byterange/media.m3u8').toString('utf8');
    const media = fixture('byterange/media.ts');
    const server = await startFixtureServer({
      '/media.m3u8': (_request, response) => sendText(response, playlist),
      '/media.ts': (request, response) => sendRange(request, response, media),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });
    const result = await downloader.download({
      url: `${server.origin}/media.m3u8`,
      headers: { Range: 'bytes=9-10' },
      maxRetry: 2,
    });

    expect(result.totalSegments).toBe(2);
    expect(
      server.requests
        .filter((request) => request.path === '/media.ts')
        .map((request) => request.headers.range)
        .sort(),
    ).toEqual(['bytes=0-31771', 'bytes=31772-62415']);
    URL.revokeObjectURL(result.blobURL);
  });

  it('retries a transient BYTERANGE request with the same Range header', async () => {
    const playlist = fixture('byterange/media.m3u8').toString('utf8');
    const media = fixture('byterange/media.ts');
    let failed = false;
    const server = await startFixtureServer({
      '/media.m3u8': (_request, response) => sendText(response, playlist),
      '/media.ts': (request, response) => {
        if (request.headers.range === 'bytes=31772-62415' && !failed) {
          failed = true;
          response.writeHead(503).end('retry range');
          return;
        }
        sendRange(request, response, media);
      },
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });
    const result = await downloader.download({ url: `${server.origin}/media.m3u8`, maxRetry: 2 });
    const retried = server.requests.filter(
      (request) => request.headers.range === 'bytes=31772-62415',
    );
    expect(retried).toHaveLength(2);
    URL.revokeObjectURL(result.blobURL);
  });

  it('locally slices a full 200 response for BYTERANGE compatibility', async () => {
    const playlist = fixture('byterange/media.m3u8').toString('utf8');
    const media = fixture('byterange/media.ts');
    const server = await startFixtureServer({
      '/media.m3u8': (_request, response) => sendText(response, playlist),
      '/media.ts': (_request, response) => sendBytes(response, media),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });
    const result = await downloader.download({ url: `${server.origin}/media.m3u8` });

    expect(result.totalSegments).toBe(2);
    expect(
      server.requests
        .filter((request) => request.path === '/media.ts')
        .map((request) => request.headers.range)
        .sort(),
    ).toEqual(['bytes=0-31771', 'bytes=31772-62415']);
    URL.revokeObjectURL(result.blobURL);
  });

  it('produces parseable fragmented MP4 chunks for EXT-X-MAP', async () => {
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
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });
    const result = await downloader.downloadToStream(
      { url: `${server.origin}/media.m3u8` },
      (bytes) => chunks.push(bytes.slice()),
    );
    const output = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const text = output.toString('latin1');

    expect(result.totalSegments).toBe(2);
    expect(text.indexOf('ftyp')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('moov')).toBeGreaterThan(text.indexOf('ftyp'));
    expect(text.indexOf('moof')).toBeGreaterThan(text.indexOf('moov'));
    expect(text.indexOf('mdat')).toBeGreaterThan(text.indexOf('moof'));
  });

  it.each(['AES-128', 'SAMPLE-AES'])(
    'rejects %s before fetching keys or segments',
    async (method) => {
      const server = await startFixtureServer({
        '/encrypted.m3u8': (_request, response) =>
          sendText(response, encryptedPlaylist(method as 'AES-128' | 'SAMPLE-AES')),
        '/key.bin': (_request, response) => sendBytes(response, new Uint8Array(16)),
        '/segment.ts': (_request, response) => sendBytes(response, new Uint8Array([1, 2, 3])),
      });
      servers.push(server);
      const downloader = new HlsDownloader({ adapter: BrowserAdapter });
      await expect(
        downloader.download({ url: `${server.origin}/encrypted.m3u8` }),
      ).rejects.toMatchObject({
        code: HlsDownloaderErrorCode.UNSUPPORTED_ENCRYPTION,
      });
      expect(server.attempts.get('/key.bin')).toBeUndefined();
      expect(server.attempts.get('/segment.ts')).toBeUndefined();
    },
  );

  it('rejects cyclic master playlists with MANIFEST_INVALID', async () => {
    const server = await startFixtureServer({
      '/cycle.m3u8': (_request, response) =>
        sendText(response, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\ncycle.m3u8\n'),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });
    await expect(downloader.download({ url: `${server.origin}/cycle.m3u8` })).rejects.toMatchObject(
      {
        code: HlsDownloaderErrorCode.MANIFEST_INVALID,
      },
    );
  });

  it.each(unsupportedMediaScenarios)(
    'rejects %s playlists before fetching media',
    async (_name, manifest) => {
      const server = await startFixtureServer({
        '/media.m3u8': (_request, response) => sendText(response, manifest),
        '/segment.ts': (_request, response) => sendBytes(response, new Uint8Array([1])),
      });
      servers.push(server);
      const downloader = new HlsDownloader({ adapter: BrowserAdapter });

      await expect(
        downloader.download({ url: `${server.origin}/media.m3u8` }),
      ).rejects.toMatchObject({
        code: HlsDownloaderErrorCode.TRANSMUX_FAILED,
      });
      expect(server.attempts.get('/segment.ts')).toBeUndefined();
    },
  );

  it('rejects alternate renditions instead of silently dropping tracks', async () => {
    const server = await startFixtureServer({
      '/master.m3u8': (_request, response) => sendText(response, alternateRenditionMaster),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });

    await expect(
      downloader.download({ url: `${server.origin}/master.m3u8` }),
    ).rejects.toMatchObject({
      code: HlsDownloaderErrorCode.TRANSMUX_FAILED,
    });
    expect(server.attempts.get('/video.m3u8')).toBeUndefined();
    expect(server.attempts.get('/audio.m3u8')).toBeUndefined();
  });

  it('reports an empty master as NO_VARIANT', async () => {
    const server = await startFixtureServer({
      '/empty.m3u8': (_request, response) => sendText(response, emptyMaster),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });

    await expect(downloader.download({ url: `${server.origin}/empty.m3u8` })).rejects.toMatchObject(
      {
        code: HlsDownloaderErrorCode.NO_VARIANT,
      },
    );
  });

  it('rejects master recursion deeper than eight levels', async () => {
    const routes = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `/level-${index}.m3u8`,
        (_request: unknown, response: Parameters<typeof sendText>[0]) =>
          sendText(
            response,
            `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlevel-${index + 1}.m3u8\n`,
          ),
      ]),
    );
    const server = await startFixtureServer(routes);
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });

    await expect(
      downloader.download({ url: `${server.origin}/level-0.m3u8` }),
    ).rejects.toMatchObject({
      code: HlsDownloaderErrorCode.MANIFEST_INVALID,
    });
  });

  it('rejects an invalid manifest with MANIFEST_INVALID', async () => {
    const server = await startFixtureServer({
      '/invalid.m3u8': (_request, response) => sendText(response, 'not an HLS manifest'),
    });
    servers.push(server);
    const downloader = new HlsDownloader({ adapter: BrowserAdapter });
    await expect(
      downloader.download({ url: `${server.origin}/invalid.m3u8` }),
    ).rejects.toMatchObject({ code: HlsDownloaderErrorCode.MANIFEST_INVALID });
  });
});
