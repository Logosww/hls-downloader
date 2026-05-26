import { describe, expect, it, vi } from 'vitest';
import { HlsDownloader } from '@hls-downloader/core';
import {
  buildBrowserFfmpegOutputArgs,
  buildFfmpegOutputArgs,
  createAdapter,
  getDownloadFilenameBase,
  getDownloadOutputExt,
  getDownloadOutputFilename,
  getAdapterGlobalOptionsFromInternal,
  getInternalAdapter,
  getTranscodeDefaultFilename,
  getTranscodeMimeType,
  HlsDownloaderEvent,
  injectContext,
  isRegisteredAdapter,
  needsBrowserFfmpegTranscode,
  needsFfmpegTranscode,
  resolveTranscodeOptions,
  selectBestVariant,
  stripContext,
} from '@hls-downloader/shared';
import type {
  HlsDownloaderAdapterInternal,
  HlsDownloaderFetchOptions,
  HlsDownloaderTranscodeOptions,
  ParseHlsResult,
} from '@hls-downloader/shared';

type TestGlobalOptions = {
  download?: {
    headers?: Record<string, string>;
    concurrency?: number;
    maxRetry?: number;
  };
  transcode?: HlsDownloaderTranscodeOptions;
  token?: string;
};

type TestDownloadResult = {
  url: string;
  headers?: Record<string, string>;
  filename: string;
  maxRetry: number;
  downloadConcurrency: number;
  transcode?: HlsDownloaderTranscodeOptions;
  token?: string;
  totalSegments: number;
};

function createMemoryAdapter() {
  const calls = {
    init: vi.fn(),
    parseHls: vi.fn(),
    download: vi.fn(),
    getPosterUrl: vi.fn(),
  };

  const internal: HlsDownloaderAdapterInternal<TestGlobalOptions, TestDownloadResult> = {
    name: 'MemoryAdapter',
    chunkDownloadConcurrency: 3,
    segmentRetryAttempts: 5,
    async init(options) {
      calls.init(stripContext(options ?? {}));
    },
    async parseHls(options) {
      const fetchOptions = stripContext(options) as HlsDownloaderFetchOptions;
      calls.parseHls(fetchOptions);

      if (fetchOptions.url.endsWith('/error.m3u8')) {
        return { type: 'error', message: 'fixture error' };
      }

      if (fetchOptions.url.endsWith('/master.m3u8')) {
        return {
          type: 'playlist',
          data: [
            { name: 'low', bandwidth: 1, uri: 'https://cdn.example.test/low.m3u8' },
            { name: 'high', bandwidth: 9, uri: 'https://cdn.example.test/high.m3u8' },
          ],
        };
      }

      return {
        type: 'segment',
        data: [
          { uri: `${fetchOptions.url}/segment-0.ts`, duration: 4 },
          { uri: `${fetchOptions.url}/segment-1.ts`, duration: 5 },
        ],
      };
    },
    async download(options) {
      const globalOptions =
        getAdapterGlobalOptionsFromInternal<TestGlobalOptions>(internal, options) ?? {};
      const fetchOptions = stripContext(options) as HlsDownloaderFetchOptions & {
        filename?: string;
        maxRetry?: number;
        downloadConcurrency?: number;
        transcode?: HlsDownloaderTranscodeOptions;
        token?: string;
      };
      calls.download(fetchOptions);

      return {
        url: fetchOptions.url,
        headers: fetchOptions.headers ?? globalOptions.download?.headers,
        filename: fetchOptions.filename ?? 'output',
        maxRetry:
          fetchOptions.maxRetry ?? globalOptions.download?.maxRetry ?? internal.segmentRetryAttempts,
        downloadConcurrency:
          fetchOptions.downloadConcurrency ??
          globalOptions.download?.concurrency ??
          internal.chunkDownloadConcurrency,
        transcode: fetchOptions.transcode ?? globalOptions.transcode,
        token: fetchOptions.token ?? globalOptions.token,
        totalSegments: 2,
      };
    },
    async getPosterUrl(options) {
      const fetchOptions = stripContext(options) as HlsDownloaderFetchOptions;
      calls.getPosterUrl(fetchOptions);
      return `${fetchOptions.url}/poster.jpg`;
    },
  };

  return {
    adapter: createAdapter(internal),
    internal,
    calls,
  };
}

describe('library API e2e', () => {
  it('runs the HlsDownloader public flow through a registered adapter', async () => {
    const events: HlsDownloaderEvent[] = [];
    const { adapter, internal, calls } = createMemoryAdapter();
    const downloader = new HlsDownloader({
      adapter,
      options: {
        download: {
          headers: { authorization: 'Bearer global' },
          concurrency: 7,
          maxRetry: 11,
        },
        transcode: { preset: 'h264', crf: 24 },
        token: 'global-token',
      },
      onEvent(event) {
        events.push(event);
      },
    });

    expect(downloader.isInit).toBe(false);
    expect(isRegisteredAdapter(adapter)).toBe(true);
    expect(getInternalAdapter(adapter)).toBe(internal);
    expect(() => {
      (adapter as Record<string, unknown>).name = 'mutated';
    }).toThrow(TypeError);

    await downloader.init();
    await downloader.init();

    expect(downloader.isInit).toBe(true);
    expect(calls.init).toHaveBeenCalledTimes(1);

    const parsed = await downloader.parseHls({ url: 'https://cdn.example.test/master.m3u8' });
    expect(parsed).toEqual({
      type: 'playlist',
      data: [
        { name: 'low', bandwidth: 1, uri: 'https://cdn.example.test/low.m3u8' },
        { name: 'high', bandwidth: 9, uri: 'https://cdn.example.test/high.m3u8' },
      ],
    });

    const download = await downloader.download({
      url: 'https://cdn.example.test/video.m3u8',
      filename: 'video',
    });

    expect(download).toEqual({
      url: 'https://cdn.example.test/video.m3u8',
      headers: { authorization: 'Bearer global' },
      filename: 'video',
      maxRetry: 11,
      downloadConcurrency: 7,
      transcode: { preset: 'h264', crf: 24 },
      token: 'global-token',
      totalSegments: 2,
    });

    const override = await downloader.download({
      url: 'https://cdn.example.test/video.m3u8',
      headers: { authorization: 'Bearer call' },
      maxRetry: 1,
      downloadConcurrency: 2,
      transcode: { preset: 'vp9' },
      token: 'call-token',
    });

    expect(override).toMatchObject({
      headers: { authorization: 'Bearer call' },
      maxRetry: 1,
      downloadConcurrency: 2,
      transcode: { preset: 'vp9' },
      token: 'call-token',
    });

    expect(await downloader.getPosterUrl({ url: 'https://cdn.example.test/video.m3u8' })).toBe(
      'https://cdn.example.test/video.m3u8/poster.jpg',
    );
    expect(events).toEqual([]);
    expect(calls.parseHls).toHaveBeenCalledWith({
      url: 'https://cdn.example.test/master.m3u8',
    });
    expect(calls.getPosterUrl).toHaveBeenCalledWith({
      url: 'https://cdn.example.test/video.m3u8',
    });
  });

  it('rejects adapters that were not created by the library', () => {
    expect(
      () =>
        new HlsDownloader({
          adapter: { name: 'PlainObjectAdapter' },
        }),
    ).toThrow('Invalid adapter');
  });

  it('keeps context private to the matching internal adapter', () => {
    const first = createMemoryAdapter();
    const second = createMemoryAdapter();
    const globalOptions = { token: 'secret' };
    const contextOptions = injectContext({ url: 'https://cdn.example.test/video.m3u8' }, {
      internal: first.internal,
      getGlobalOptions: () => globalOptions,
    });

    expect(getAdapterGlobalOptionsFromInternal(first.internal, contextOptions)).toBe(globalOptions);
    expect(getAdapterGlobalOptionsFromInternal(second.internal, contextOptions)).toBeNull();
    expect(stripContext(contextOptions)).toEqual({
      url: 'https://cdn.example.test/video.m3u8',
    });
  });
});

describe('shared API e2e', () => {
  it('resolves transcode presets and ffmpeg arguments', () => {
    expect(needsFfmpegTranscode()).toBe(false);
    expect(needsFfmpegTranscode({ videoCodec: 'copy', audioCodec: 'copy' })).toBe(false);
    expect(needsFfmpegTranscode({ preset: 'h264' })).toBe(true);
    expect(needsFfmpegTranscode({ format: 'webm' })).toBe(true);
    expect(needsBrowserFfmpegTranscode({ preset: 'h264' })).toBe(true);
    expect(resolveTranscodeOptions({ preset: 'vp9', crf: 32 })).toEqual({
      preset: 'vp9',
      crf: 32,
      videoCodec: 'libvpx-vp9',
      audioCodec: 'libopus',
      format: 'webm',
    });
    expect(getDownloadFilenameBase('archive.video.mp4')).toBe('archive.video');
    expect(getDownloadOutputExt()).toBe('mp4');
    expect(getDownloadOutputFilename('video.mp4')).toBe('video.mp4');
    expect(getDownloadOutputFilename('video', { preset: 'vp9' })).toBe('video.webm');
    expect(
      getDownloadOutputFilename('video', { videoCodec: 'libvpx-vp9', audioCodec: 'libopus' }),
    ).toBe('video.webm');
    expect(getDownloadOutputFilename('video', { preset: 'vp9', format: 'mp4' })).toBe(
      'video.mp4',
    );
    expect(getTranscodeDefaultFilename({ preset: 'vp9' })).toBe('output.webm');
    expect(getTranscodeMimeType({ preset: 'h264' })).toBe('video/mp4');
    expect(buildFfmpegOutputArgs({ preset: 'h264', crf: 23, speed: 'fast' })).toEqual([
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-f',
      'mp4',
      '-crf',
      '23',
      '-preset',
      'fast',
    ]);
    expect(buildBrowserFfmpegOutputArgs()).toEqual([
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-f',
      'mp4',
      '-movflags',
      '+faststart',
    ]);
  });

  it('selects the best playlist and preserves parse result shapes', () => {
    expect(
      selectBestVariant([
        { name: 'low', bandwidth: 100, uri: 'low.m3u8' },
        { name: 'high', bandwidth: 300, uri: 'high.m3u8' },
        { name: 'mid', bandwidth: 200, uri: 'mid.m3u8' },
      ]),
    ).toEqual({ name: 'high', bandwidth: 300, uri: 'high.m3u8' });
    expect(selectBestVariant([])).toBeUndefined();

    const segmentResult: ParseHlsResult = {
      type: 'segment',
      data: [{ uri: 'segment.ts', duration: 1 }],
    };
    const errorResult: ParseHlsResult = {
      type: 'error',
      message: 'failed',
    };

    expect(segmentResult.data[0]?.uri).toBe('segment.ts');
    expect(errorResult.message).toBe('failed');
  });

  it('exports stable event names', () => {
    expect(HlsDownloaderEvent).toMatchObject({
      FFMPEG_LOADING: 'ffmpeg-loading',
      FFMPEG_LOADED: 'ffmpeg-loaded',
      STARTING_DOWNLOAD: 'starting-download',
      SOURCE_PARSED: 'source-parsed',
      DOWNLOADING: 'downloading',
      DOWNLOADING_SEGMENTS: 'downloading-segments',
      STICHING_SEGMENTS: 'stiching-segments',
      READY_FOR_DOWNLOAD: 'ready-for-download',
      ERROR: 'error',
    });
  });
});
