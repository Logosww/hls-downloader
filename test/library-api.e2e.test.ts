import { describe, expect, it, vi } from 'vitest';
import { HlsDownloader } from '@hls-downloader/core';
import {
  assertBrowserTranscodeOptions,
  buildFfmpegOutputArgs,
  createAdapter,
  emitAdapterEvent,
  getDownloadFilenameBase,
  getDownloadOutputExt,
  getDownloadOutputFilename,
  getAdapterGlobalOptionsFromInternal,
  getInternalAdapter,
  getTranscodeDefaultFilename,
  getTranscodeMimeType,
  HlsDownloaderEvent,
  HlsDownloaderError,
  HlsDownloaderErrorCode,
  injectContext,
  isAudioOnlyCodecs,
  isRegisteredAdapter,
  needsBrowserTranscode,
  needsFfmpegTranscode,
  resolveTranscodeOptions,
  selectBestVariant,
  sanitizeHlsUrl,
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
    capabilities: {
      download: true,
      stream: true,
      transcodePresets: [],
      configurableRetry: true,
      byteRange: 'unknown',
      aes128: 'unknown',
      liveRecording: false,
      persistentOutput: false,
    },
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
          fetchOptions.maxRetry ??
          globalOptions.download?.maxRetry ??
          internal.segmentRetryAttempts,
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
    expect(downloader.capabilities).toMatchObject({ download: true, stream: true });
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
      operationId: 'download-primary',
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
      operationId: 'download-primary',
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
    expect(override.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

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

  it('isolates events by downloader and concurrent operation', async () => {
    type Result = { label: string; totalSegments: number };
    const internal: HlsDownloaderAdapterInternal<Record<string, never>, Result> = {
      name: 'ConcurrentAdapter',
      capabilities: {
        download: true,
        stream: true,
        transcodePresets: [],
        configurableRetry: true,
        byteRange: 'unknown',
        aes128: 'unknown',
        liveRecording: false,
        persistentOutput: false,
      },
      chunkDownloadConcurrency: 2,
      segmentRetryAttempts: 2,
      async init() {},
      async parseHls() {
        return { type: 'segment', data: [] };
      },
      async download(options) {
        emitAdapterEvent(internal, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
        await new Promise((resolve) =>
          setTimeout(resolve, options.url.endsWith('/slow.m3u8') ? 15 : 1),
        );
        emitAdapterEvent(internal, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
        return { label: options.url, totalSegments: 0 };
      },
      async downloadToStream(options, onChunk) {
        emitAdapterEvent(internal, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
        onChunk(new Uint8Array([1]));
        emitAdapterEvent(internal, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
        return { totalSegments: 0 };
      },
      async getPosterUrl() {
        return undefined;
      },
    };
    const adapter = createAdapter(internal);
    const firstEvents: string[] = [];
    const secondEvents: string[] = [];
    const first = new HlsDownloader({
      adapter,
      onEvent: (_event, payload) => firstEvents.push(payload.operationId),
    });
    const second = new HlsDownloader({
      adapter,
      onEvent: (_event, payload) => secondEvents.push(payload.operationId),
    });

    const [slow, fast, streamed] = await Promise.all([
      first.download({ url: 'https://example.test/slow.m3u8', operationId: 'slow' }),
      first.download({ url: 'https://example.test/fast.m3u8', operationId: 'fast' }),
      second.downloadToStream(
        { url: 'https://example.test/stream.m3u8', operationId: 'stream' },
        () => {},
      ),
    ]);

    expect([slow.operationId, fast.operationId, streamed.operationId]).toEqual([
      'slow',
      'fast',
      'stream',
    ]);
    expect(firstEvents).toEqual(['slow', 'fast', 'fast', 'slow']);
    expect(secondEvents).toEqual(['stream', 'stream']);
  });

  it('normalizes failures and emits one structured error event', async () => {
    const errorEvents: HlsDownloaderError[] = [];
    const { adapter, internal } = createMemoryAdapter();
    internal.download = async () => {
      throw new Error('native failure');
    };
    const downloader = new HlsDownloader({
      adapter,
      onEvent(event, payload) {
        if (event === HlsDownloaderEvent.ERROR) errorEvents.push(payload.error);
      },
    });

    const failure = downloader.download({
      url: 'https://user:secret@example.test/video.m3u8?token=sensitive#fragment',
      operationId: 'failed-operation',
    });
    await expect(failure).rejects.toMatchObject({
      name: 'HlsDownloaderError',
      code: HlsDownloaderErrorCode.TRANSMUX_FAILED,
      url: 'https://example.test/video.m3u8',
      adapter: 'MemoryAdapter',
      recoverable: false,
    });
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toBeInstanceOf(HlsDownloaderError);
  });

  it('preserves AbortError compatibility and sanitizes URLs', async () => {
    const { adapter, internal } = createMemoryAdapter();
    internal.download = async () => {
      throw new DOMException('cancelled', 'AbortError');
    };
    const downloader = new HlsDownloader({ adapter });

    await expect(
      downloader.download({ url: 'https://example.test/video.m3u8?token=secret' }),
    ).rejects.toMatchObject({
      name: 'AbortError',
      code: HlsDownloaderErrorCode.ABORTED,
    });
    expect(sanitizeHlsUrl('https://user:pass@example.test/a.m3u8?q=1#x')).toBe(
      'https://example.test/a.m3u8',
    );
    expect(sanitizeHlsUrl('not a URL')).toBeUndefined();
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
    const contextOptions = injectContext(
      { url: 'https://cdn.example.test/video.m3u8' },
      {
        internal: first.internal,
        getGlobalOptions: () => globalOptions,
      },
    );

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
    expect(needsBrowserTranscode({ preset: 'h264' })).toBe(true);
    expect(needsBrowserTranscode({ preset: 'vp9', videoBitrate: '4M' })).toBe(true);
    expect(
      assertBrowserTranscodeOptions({
        preset: 'hevc',
        videoBitrate: 4_000_000,
        audioBitrate: '128k',
      }),
    ).toEqual({
      preset: 'hevc',
      videoBitrate: 4_000_000,
      audioBitrate: '128k',
    });
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
    expect(getDownloadOutputFilename('video', { preset: 'vp9', format: 'mp4' })).toBe('video.mp4');
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

  it('filters audio-only variants and prefers higher resolution', () => {
    // 高 bandwidth 纯音频 variant 不应被选中，应选低 bandwidth 的视频 variant
    expect(
      selectBestVariant([
        {
          name: 'audio',
          bandwidth: 9999,
          uri: 'audio.m3u8',
          codecs: 'mp4a.40.2',
          isAudioOnly: true,
        },
        {
          name: '720p',
          bandwidth: 1000,
          uri: '720p.m3u8',
          resolution: { width: 1280, height: 720 },
          codecs: 'avc1.640028,mp4a.40.2',
          isAudioOnly: false,
        },
      ]),
    ).toEqual({
      name: '720p',
      bandwidth: 1000,
      uri: '720p.m3u8',
      resolution: { width: 1280, height: 720 },
      codecs: 'avc1.640028,mp4a.40.2',
      isAudioOnly: false,
    });

    // 同 resolution 按 bandwidth 更高者胜出
    expect(
      selectBestVariant([
        {
          name: '720p-low',
          bandwidth: 1000,
          uri: '720p-low.m3u8',
          resolution: { width: 1280, height: 720 },
        },
        {
          name: '720p-high',
          bandwidth: 2000,
          uri: '720p-high.m3u8',
          resolution: { width: 1280, height: 720 },
        },
      ]),
    ).toEqual({
      name: '720p-high',
      bandwidth: 2000,
      uri: '720p-high.m3u8',
      resolution: { width: 1280, height: 720 },
    });

    // 全部为纯音频时回退到最高 bandwidth
    expect(
      selectBestVariant([
        { name: 'audio-low', bandwidth: 100, uri: 'a-low.m3u8', isAudioOnly: true },
        { name: 'audio-high', bandwidth: 300, uri: 'a-high.m3u8', isAudioOnly: true },
      ]),
    ).toEqual({ name: 'audio-high', bandwidth: 300, uri: 'a-high.m3u8', isAudioOnly: true });

    // isAudioOnlyCodecs helper
    expect(isAudioOnlyCodecs('mp4a.40.2')).toBe(true);
    expect(isAudioOnlyCodecs('ac-3')).toBe(true);
    expect(isAudioOnlyCodecs('avc1.640028,mp4a.40.2')).toBe(false);
    expect(isAudioOnlyCodecs(undefined)).toBe(false);
  });

  it('respects variant select options (maxResolution / maxBandwidth / preferredCodec)', () => {
    const playlists = [
      {
        name: '1080p-avc',
        bandwidth: 5000,
        uri: '1080p-avc.m3u8',
        resolution: { width: 1920, height: 1080 },
        codecs: 'avc1.640028,mp4a.40.2',
      },
      {
        name: '720p-avc',
        bandwidth: 2800,
        uri: '720p-avc.m3u8',
        resolution: { width: 1280, height: 720 },
        codecs: 'avc1.640020,mp4a.40.2',
      },
      {
        name: '720p-hevc',
        bandwidth: 2500,
        uri: '720p-hevc.m3u8',
        resolution: { width: 1280, height: 720 },
        codecs: 'hvc1.1.6.L93.B0,mp4a.40.2',
      },
    ];

    // maxResolution 限制在 720p：不应选 1080p
    expect(
      selectBestVariant(playlists, { maxResolution: { width: 1280, height: 720 } })!.name,
    ).toBe('720p-avc');

    // preferredCodec=hvc1：720p-hevc 优先（即便带宽略低）
    expect(
      selectBestVariant(playlists, {
        maxResolution: { width: 1280, height: 720 },
        preferredCodec: 'hvc1',
      })!.name,
    ).toBe('720p-hevc');

    // maxBandwidth 限制：选不超过上限的最高分辨率
    expect(selectBestVariant(playlists, { maxBandwidth: 2600 })!.name).toBe('720p-hevc');

    // 无 options：最高分辨率（1080p）
    expect(selectBestVariant(playlists)!.name).toBe('1080p-avc');
  });

  it('exports stable event names', () => {
    expect(HlsDownloaderEvent).toMatchObject({
      FFMPEG_LOADING: 'ffmpeg-loading',
      FFMPEG_LOADED: 'ffmpeg-loaded',
      STARTING_DOWNLOAD: 'starting-download',
      SOURCE_PARSED: 'source-parsed',
      DOWNLOADING: 'downloading',
      DOWNLOADING_SEGMENTS: 'downloading-segments',
      STITCHING_SEGMENTS: 'stitching-segments',
      READY_FOR_DOWNLOAD: 'ready-for-download',
      ERROR: 'error',
    });
  });
});
