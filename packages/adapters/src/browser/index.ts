import { resolveMedia } from '../renditions';
import { withOperation, executePrepared, exportSubtitles, type Engine } from '../prepared';
import { prepared_browser } from './wasm';
import { Parser } from 'm3u8-parser';
import {
  createAdapter,
  emitAdapterEvent,
  getAdapterGlobalOptionsFromInternal,
  HlsDownloaderEvent,
  stripContext,
  mapManifest,
  type HlsDownloaderAdapterInternal,
  type HlsDownloaderDownloadOptions,
  type HlsDownloaderFetchOptions,
  type HlsDownloaderGlobalDownloadOptions,
  assertBrowserTranscodeOptions,
  getDownloadOutputFilename,
  HlsDownloaderError,
  HlsDownloaderErrorCode,
  needsBrowserTranscode,
  normalizeHlsError,
  type HlsDownloaderBrowserTranscodeOptions,
  type ParseHlsResult,
  type Segment,
} from '@hls-downloader/shared';
import { transcodeHls } from './mediabunny';
import { extractPosterFromSegmentUrl } from './poster';
import { promiseWithLimit } from './utils';
import type {
  HlsDownloaderBrowserRequestOptions,
  HlsDownloaderBrowserOperationOptions,
} from '@hls-downloader/shared';
import { assertActive, cancellable } from './request';
import {
  ensureWasm,
  transmuxDemandToFmp4,
  transmuxPreloadedToMp4,
  type HlsWasmResources,
} from './wasm';

import {
  createResourceWindow,
  readResource,
  resolveWritablePlaylist,
  checkSignal,
} from './writable';

type DownloadResult = {
  blobURL: string;
  totalSegments: number;
};

type BrowserAdditionalOptions = HlsDownloaderBrowserOperationOptions & {
  transcode?: HlsDownloaderBrowserTranscodeOptions;
};

export type HlsDownloaderBrowserAdapter = HlsDownloaderAdapterInternal<
  BrowserAdditionalOptions,
  DownloadResult,
  {},
  HlsDownloaderBrowserOperationOptions
>;

export type {
  HlsDownloaderBrowserTranscodeOptions,
  HlsDownloaderBrowserRequestOptions,
  HlsDownloaderBrowserOperationOptions,
};

type BrowserGlobalOptions = {
  download?: HlsDownloaderGlobalDownloadOptions;
} & BrowserAdditionalOptions;

function mergeFetchOptions(
  globalOptions: BrowserGlobalOptions | null,
  options: Record<string, unknown>,
): HlsDownloaderFetchOptions & HlsDownloaderBrowserOperationOptions {
  const callOptions = stripContext(options) as HlsDownloaderFetchOptions &
    HlsDownloaderBrowserOperationOptions;

  return {
    headers: globalOptions?.download?.headers,
    ...callOptions,
    signal: callOptions.signal,
    browserRequest: { ...(callOptions.browserRequest ?? globalOptions?.browserRequest) },
  };
}

function mergeDownloadOptions(
  adapter: HlsDownloaderBrowserAdapter,
  globalOptions: BrowserGlobalOptions | null,
  options: Record<string, unknown>,
) {
  const callOptions = stripContext(options) as HlsDownloaderFetchOptions &
    HlsDownloaderDownloadOptions &
    BrowserAdditionalOptions;

  const mergedTranscode = callOptions.transcode ?? globalOptions?.transcode;
  const filename = getDownloadOutputFilename(callOptions.filename, mergedTranscode);

  return {
    url: callOptions.url,
    headers: callOptions.headers ?? globalOptions?.download?.headers,
    filename,
    maxRetry:
      callOptions.maxRetry ?? globalOptions?.download?.maxRetry ?? adapter.segmentRetryAttempts,
    downloadConcurrency:
      callOptions.downloadConcurrency ??
      globalOptions?.download?.concurrency ??
      adapter.chunkDownloadConcurrency,
    transcode: mergedTranscode,
    signal: callOptions.signal,
    browserRequest: { ...(callOptions.browserRequest ?? globalOptions?.browserRequest) },
  };
}

const init: HlsDownloaderBrowserAdapter['init'] = async function () {
  // WASM and WebCodecs are initialized lazily by the operation that needs them.
};

const parseHls: HlsDownloaderBrowserAdapter['parseHls'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
  const {
    url: hlsUrl,
    headers,
    signal,
    browserRequest,
  } = mergeFetchOptions(globalOptions, options);
  const maxRetry =
    (stripContext(options) as HlsDownloaderDownloadOptions).maxRetry ??
    globalOptions?.download?.maxRetry ??
    this.segmentRetryAttempts;

  let fallbackCode: (typeof HlsDownloaderErrorCode)[keyof typeof HlsDownloaderErrorCode] =
    HlsDownloaderErrorCode.MANIFEST_FETCH_FAILED;
  try {
    let url = new URL(hlsUrl);

    const response = await readResource(
      { url: url.href },
      headers,
      maxRetry,
      signal ?? new AbortController().signal,
      HlsDownloaderErrorCode.MANIFEST_FETCH_FAILED,
      browserRequest,
    );
    url = new URL(response.url);
    const manifest = new TextDecoder().decode(response.bytes);
    fallbackCode = HlsDownloaderErrorCode.MANIFEST_INVALID;

    const parser = new Parser();
    parser.push(manifest);
    parser.end();

    for (const variant of parser.manifest.playlists ?? [])
      variant.uri = new URL(variant.uri, url).href;
    for (const segment of parser.manifest.segments ?? []) {
      segment.uri = new URL(segment.uri, url).href;
      if (segment.map?.uri) segment.map.uri = new URL(segment.map.uri, url).href;
    }
    const result = mapManifest(parser.manifest, new URL('.', url).href + '{{URL}}');
    assertActive(signal);
    return result;
  } catch (cause: unknown) {
    // error 不缓存，下次调用重新走网络
    const error = normalizeHlsError(cause, fallbackCode, {
      url: hlsUrl,
      adapter: this.name,
    });
    const result: ParseHlsResult = {
      type: 'error',
      message: error.message,
      error,
    };
    return result;
  }
};

async function resolveToSegments(
  adapter: HlsDownloaderBrowserAdapter,
  options: Record<string, unknown>,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(adapter, options);
  const merged = mergeDownloadOptions(adapter, globalOptions, options);
  const result = await resolveWritablePlaylist({
    ...options,
    ...merged,
    transcode: undefined,
    signal: merged.signal ?? new AbortController().signal,
  });
  return { segments: result.segments, resolvedUrl: result.url, playlist: result.playlist };
}

const getPosterUrl: HlsDownloaderBrowserAdapter['getPosterUrl'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const fetchOptions = mergeFetchOptions(
    getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options),
    options,
  );

  const { segments } = await resolveToSegments(this, { ...options, ...fetchOptions });
  const index = Math.min(Math.floor(segments.length * 0.25), segments.length - 1);
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
  return extractPosterFromSegmentUrl({
    segment: segments[index]!,
    headers: fetchOptions.headers,
    signal: fetchOptions.signal,
    browserRequest: fetchOptions.browserRequest,
    maxRetry: globalOptions?.download?.maxRetry ?? this.segmentRetryAttempts,
  });
};

const download: HlsDownloaderBrowserAdapter['download'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
  const { url, headers, maxRetry, downloadConcurrency, transcode, signal, browserRequest } =
    mergeDownloadOptions(this, globalOptions, options);

  emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);

  if (signal?.aborted) {
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
      adapter: this.name,
    });
  }

  if (!needsBrowserTranscode(transcode)) {
    return withOperation(
      { ...options, url, headers, maxRetry, downloadConcurrency, signal, browserRequest },
      async (request) => {
        const media = await resolveMedia(request, transcode !== undefined);
        emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
        if (!media.audio) {
          const blobURL = await downloadAndTransmux({
            url: media.primary.url,
            playlist: media.primary.text,
            segments: media.primary.segments.map((s, index) => ({ ...s, index })),
            headers,
            maxRetry,
            downloadConcurrency,
            signal: request.signal,
            browserRequest,
            onProgress: (completed) =>
              emitAdapterEvent(this, options, HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
                completed,
                total: media.totalSegments,
              }),
            onMuxProgress: (completed) =>
              emitAdapterEvent(this, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
                completed,
                total: media.totalSegments,
              }),
          });
          emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
          return { blobURL, totalSegments: media.totalSegments };
        }
        let buffer: Uint8Array | undefined;
        const report = await executePrepared(
          this,
          request,
          media,
          browserEngine,
          'bytes',
          async (bytes) => {
            buffer = bytes;
          },
        );
        assertActive(request.signal);
        const blobURL = URL.createObjectURL(
          new Blob([Uint8Array.from(buffer!).buffer], { type: 'video/mp4' }),
        );
        emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
        return { blobURL, totalSegments: report.totalSegments };
      },
    );
  }
  const { primary } = await resolveMedia(
    { ...options, url, headers, signal, browserRequest, maxRetry },
    true,
  );
  const { segments, url: resolvedUrl, text: playlist } = primary;
  emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);

  const browserTranscode = assertBrowserTranscodeOptions(transcode);
  const result = await transcodeHls({
    url: resolvedUrl,
    transcode: browserTranscode,
    playlist,
    headers,
    maxRetry,
    signal,
    browserRequest,
    segmentUrls: segments.map((segment) => segment.uri),
    onSegmentLoaded: (completed) => {
      emitAdapterEvent(this, options, HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
        total: segments.length,
        completed,
      });
    },
    onProgress: (progress) => {
      emitAdapterEvent(this, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
        total: 100,
        completed: Math.floor(progress * 100),
      });
    },
  });

  emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);

  assertActive(signal);
  const blobURL = URL.createObjectURL(new Blob([result.buffer], { type: result.mimeType }));

  return {
    blobURL,
    totalSegments: segments.length,
  };
};

type DownloadFileOptions = {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  browserRequest?: HlsDownloaderBrowserRequestOptions;
  range?: { offset: number; length: number };
};

type DownloadAndTransmuxOptions = {
  playlist: string;
  url: string;
  segments: Array<Segment & { index: number }>;
  headers?: Record<string, string>;
  maxRetry: number;
  downloadConcurrency: number;
  signal?: AbortSignal;
  browserRequest?: HlsDownloaderBrowserRequestOptions;
  onProgress: (completed: number) => void;
  onMuxProgress: (completed: number) => void;
};

const downloadAndTransmux = async ({
  url,
  playlist,
  segments,
  headers,
  maxRetry,
  downloadConcurrency,
  signal,
  browserRequest,
  onProgress,
  onMuxProgress,
}: DownloadAndTransmuxOptions) => {
  const resources = await preloadHlsResources({
    playlistUrl: url,
    playlist,
    segments,
    headers,
    maxRetry,
    downloadConcurrency,
    signal,
    browserRequest,
    onProgress,
  });
  if (signal?.aborted) {
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
      adapter: 'BrowserAdapter',
      url,
    });
  }
  const { buffer } = await transmuxPreloadedToMp4(resources);
  assertActive(signal);
  onMuxProgress(segments.length);

  return URL.createObjectURL(new Blob([Uint8Array.from(buffer).buffer], { type: 'video/mp4' }));
};

const downloadSegmentBytesWithRetry = async ({
  maxRetry,
  segmentIndex,
  ...options
}: DownloadFileOptions & {
  maxRetry: number;
  segmentIndex?: number;
}) => {
  try {
    return (
      await readResource(
        options,
        options.headers,
        maxRetry,
        options.signal ?? new AbortController().signal,
        HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
        options.browserRequest,
      )
    ).bytes;
  } catch (error) {
    if (error instanceof HlsDownloaderError)
      throw new HlsDownloaderError(error.code, error.message, {
        url: error.url,
        status: error.status,
        attempt: error.attempt,
        adapter: error.adapter,
        segmentIndex,
      });
    throw error;
  }
};

type PreloadHlsResourcesOptions = {
  playlist: string;
  playlistUrl: string;
  segments: Segment[];
  headers?: Record<string, string>;
  maxRetry: number;
  downloadConcurrency: number;
  signal?: AbortSignal;
  browserRequest?: HlsDownloaderBrowserRequestOptions;
  onProgress: (completed: number) => void;
};

function resolveResourceUrl(path: string, playlistUrl: string): string {
  return new URL(path, playlistUrl).href;
}

type ResourceSpec = {
  url: string;
  range?: { offset: number; length: number };
};

function toRange(value: unknown): ResourceSpec['range'] {
  if (!value || typeof value !== 'object') return undefined;
  const { offset, length } = value as { offset?: unknown; length?: unknown };
  return typeof offset === 'number' && typeof length === 'number' && length > 0
    ? { offset, length }
    : undefined;
}

function getSegmentResources(segment: Segment, playlistUrl: string): ResourceSpec[] {
  const resources: ResourceSpec[] = [
    {
      url: resolveResourceUrl(segment.uri, playlistUrl),
      range: toRange(segment.byterange),
    },
  ];
  if (typeof segment.map?.uri === 'string') {
    resources.push({
      url: resolveResourceUrl(segment.map.uri, playlistUrl),
      range: toRange(segment.map.byterange),
    });
  }
  return resources;
}

async function preloadHlsResources({
  playlistUrl,
  playlist,
  segments,
  headers,
  maxRetry,
  downloadConcurrency,
  signal,
  browserRequest,
  onProgress,
}: PreloadHlsResourcesOptions): Promise<HlsWasmResources> {
  const segmentCounts = new Map<string, number>();
  const resourceSegmentIndexes = new Map<string, number>();
  const resources = new Map<string, ResourceSpec>();

  const resourceKey = (resource: ResourceSpec) =>
    resource.range
      ? `${resource.url}\u0000${resource.range.offset}:${resource.range.length}`
      : `${resource.url}\u0000full`;

  for (const [segmentIndex, segment] of segments.entries()) {
    const [segmentResource, ...additionalResources] = getSegmentResources(segment, playlistUrl);
    if (!segmentResource) continue;
    const segmentKey = resourceKey(segmentResource);
    segmentCounts.set(segmentKey, (segmentCounts.get(segmentKey) ?? 0) + 1);
    resources.set(segmentKey, segmentResource);
    resourceSegmentIndexes.set(segmentKey, segmentIndex);
    for (const resource of additionalResources) {
      const key = resourceKey(resource);
      resources.set(key, resource);
      if (!resourceSegmentIndexes.has(key)) {
        resourceSegmentIndexes.set(key, segmentIndex);
      }
    }
  }

  let completed = 0;
  const entries = await promiseWithLimit(
    [...resources.entries()].map(([key, resource]) => async () => {
      const bytes = await downloadSegmentBytesWithRetry({
        url: resource.url,
        range: resource.range,
        headers,
        maxRetry,
        segmentIndex: resourceSegmentIndexes.get(key),
        signal,
        browserRequest,
      });
      completed += segmentCounts.get(key) ?? 0;
      if (segmentCounts.has(key)) onProgress(completed);
      return { resource, bytes };
    }),
    downloadConcurrency,
  );

  const fullBytes: Record<string, Uint8Array> = {};
  const ranges: HlsWasmResources['ranges'] = [];
  for (const { resource, bytes } of entries) {
    if (resource.range) ranges.push({ url: resource.url, ...resource.range, bytes });
    else fullBytes[resource.url] = bytes;
  }

  return {
    playlistUrl,
    texts: { [playlistUrl]: playlist },
    bytes: fullBytes,
    ranges,
  };
}

const legacyDownloadToWritable: NonNullable<HlsDownloaderBrowserAdapter['downloadToWritable']> =
  async function (this: HlsDownloaderBrowserAdapter, options, write) {
    const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
    // This path never merges global transcode settings.
    const { url, headers, browserRequest } = mergeFetchOptions(globalOptions, options);
    const maxRetry =
      options.maxRetry ?? globalOptions?.download?.maxRetry ?? this.segmentRetryAttempts;
    const concurrency =
      options.downloadConcurrency ??
      globalOptions?.download?.concurrency ??
      this.chunkDownloadConcurrency;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    const signal = controller.signal;
    const snapshot = (
      options as typeof options & { __media?: import('../renditions').MediaSnapshot }
    ).__media;
    let window: ReturnType<typeof createResourceWindow> | undefined;
    let originalError: unknown;
    // Preserve JS structured errors across the string-valued WASM error boundary.
    const guard =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A) => {
        let onAbort: (() => void) | undefined;
        try {
          checkSignal(signal);
          const cancelled = new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
          });
          return await Promise.race([fn(...args), cancelled]);
        } catch (error) {
          originalError ??= error;
          controller.abort(error);
          throw error;
        } finally {
          if (onAbort) signal.removeEventListener('abort', onAbort);
        }
      };
    try {
      checkSignal(signal);
      if (!snapshot) emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
      const {
        playlist,
        url: resolvedUrl,
        segments,
      } = snapshot
        ? { playlist: snapshot.text, url: snapshot.url, segments: snapshot.segments }
        : await resolveWritablePlaylist({
            ...options,
            url,
            headers,
            maxRetry,
            signal,
            browserRequest,
          });
      if (!snapshot) emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
      window = createResourceWindow(
        segments,
        concurrency,
        guard(
          async (resource) =>
            (
              await readResource(
                resource,
                headers,
                maxRetry,
                signal,
                HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
                browserRequest,
              )
            ).bytes,
        ),
        signal,
        (completed) =>
          emitAdapterEvent(this, options, HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
            total: segments.length,
            completed,
          }),
      );
      await transmuxDemandToFmp4(resolvedUrl, playlist, guard(window.read), guard(write));
      checkSignal(signal);
      emitAdapterEvent(this, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
        total: segments.length,
        completed: segments.length,
      });
      return { totalSegments: segments.length };
    } catch (cause) {
      throw originalError ?? (signal.aborted ? signal.reason : cause);
    } finally {
      controller.abort();
      window?.dispose();
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  };

const browserEngine: Engine = async (request, read, write, progress, signal) => {
  await cancellable(ensureWasm(), signal);
  return (await prepared_browser(request, read, write, progress)) as string;
};
const downloadToWritable: NonNullable<HlsDownloaderBrowserAdapter['downloadToWritable']> =
  async function (this: HlsDownloaderBrowserAdapter, options, write) {
    const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
    const merged = mergeDownloadOptions(this, globalOptions, options);
    return withOperation({ ...options, ...merged }, async (request) => {
      emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
      const media = await resolveMedia(
        request,
        Boolean((options as Record<string, unknown>).__rejectAudio),
      );
      emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
      if (!media.audio && !options.audio) {
        // Preserve the legacy single-input timeline contract while feeding its exact snapshot.
        return legacyDownloadToWritable.call(
          this,
          { ...request, __media: media.primary } as typeof options,
          write,
        );
      }
      const report = await executePrepared(this, request, media, browserEngine, 'stream', write);
      emitAdapterEvent(this, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
        completed: report.totalSegments,
        total: report.totalSegments,
      });
      return { totalSegments: report.totalSegments };
    });
  };
const downloadToStream: HlsDownloaderBrowserAdapter['downloadToStream'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
  onChunk,
) {
  const merged = mergeDownloadOptions(
    this,
    getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options),
    options,
  );
  if (options.audio && merged.transcode)
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
      'Audio selection cannot be transcoded',
    );
  const result = await downloadToWritable.call(
    this,
    {
      ...options,
      transcode: undefined,
      __rejectAudio: merged.transcode !== undefined,
    } as Parameters<NonNullable<HlsDownloaderBrowserAdapter['downloadToWritable']>>[0],
    async (bytes) => {
      onChunk(bytes);
    },
  );
  emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
  return result;
};
const downloadSubtitles: NonNullable<HlsDownloaderBrowserAdapter['downloadSubtitles']> =
  async function (this: HlsDownloaderBrowserAdapter, options) {
    const merged = mergeDownloadOptions(
      this,
      getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options),
      options,
    );
    return withOperation({ ...options, ...merged }, async (request) => {
      emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
      const media = await resolveMedia(request);
      emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
      return exportSubtitles(
        this,
        { ...request, subtitle: options.subtitle, filename: options.filename },
        media,
        browserEngine,
      );
    });
  };

/** Each operation owns cancellation of outstanding and queued media work. */
function scopedOperation<A extends HlsDownloaderFetchOptions, R, Rest extends unknown[]>(
  operation: (this: HlsDownloaderBrowserAdapter, options: A, ...rest: Rest) => Promise<R>,
) {
  return async function (this: HlsDownloaderBrowserAdapter, options: A, ...rest: Rest): Promise<R> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      return await cancellable(
        operation.call(this, { ...options, signal: controller.signal }, ...rest),
        controller.signal,
      );
    } finally {
      controller.abort();
      options.signal?.removeEventListener('abort', abort);
    }
  };
}

const browserAdapter: HlsDownloaderBrowserAdapter = createAdapter({
  name: 'BrowserAdapter',
  capabilities: {
    download: true,
    stream: true,
    transcodePresets: ['h264', 'hevc', 'vp9'],
    configurableRetry: true,
    byteRange: true,
    aes128: false,
    liveRecording: false,
    persistentOutput: false,
    writableOutput: true,
    resumableDownload: false,
    alternateAudio: true,
    subtitleExport: true,
  },
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  getPosterUrl: scopedOperation(getPosterUrl),
  download: scopedOperation(download),
  downloadToStream: scopedOperation(downloadToStream),
  downloadToWritable,
  downloadSubtitles,
  clearCache: () => {},
}) as HlsDownloaderBrowserAdapter;

export const BrowserAdapter: HlsDownloaderBrowserAdapter = browserAdapter;

export default BrowserAdapter;
