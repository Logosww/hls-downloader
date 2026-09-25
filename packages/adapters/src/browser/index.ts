import { Parser } from 'm3u8-parser';
import {
  createAdapter,
  emitAdapterEvent,
  getAdapterGlobalOptionsFromInternal,
  HlsDownloaderEvent,
  selectBestVariant,
  stripContext,
  ParseHlsCache,
  buildParseHlsCacheKey,
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
  type Playlist,
  type Segment,
  type VariantSelectOptions,
  assertSupportedSegments,
} from '@hls-downloader/shared';
import { transcodeHls } from './mediabunny';
import { extractPosterFromSegmentUrl } from './poster';
import { promiseWithLimit } from './utils';
import { fetchWithRetry } from './retry';
import {
  ensureWasm,
  transmuxDemandToFmp4,
  transmuxPreloadedToFmp4Stream,
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

type BrowserAdditionalOptions = {
  transcode?: HlsDownloaderBrowserTranscodeOptions;
};

export type HlsDownloaderBrowserAdapter = HlsDownloaderAdapterInternal<
  BrowserAdditionalOptions,
  DownloadResult
>;

export type { HlsDownloaderBrowserTranscodeOptions };

type BrowserGlobalOptions = {
  download?: HlsDownloaderGlobalDownloadOptions;
} & BrowserAdditionalOptions;

function mergeFetchOptions(
  globalOptions: BrowserGlobalOptions | null,
  options: Record<string, unknown>,
): HlsDownloaderFetchOptions {
  const callOptions = stripContext(options) as HlsDownloaderFetchOptions;

  return {
    headers: globalOptions?.download?.headers,
    ...callOptions,
    signal: callOptions.signal,
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
  };
}

const parseResultCache = new ParseHlsCache();
const posterCache: Record<string, string | undefined> = Object.create(null);

const init: HlsDownloaderBrowserAdapter['init'] = async function () {
  // WASM and WebCodecs are initialized lazily by the operation that needs them.
};

const parseHls: HlsDownloaderBrowserAdapter['parseHls'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
  const { url: hlsUrl, headers, signal } = mergeFetchOptions(globalOptions, options);
  const maxRetry =
    (stripContext(options) as HlsDownloaderDownloadOptions).maxRetry ??
    globalOptions?.download?.maxRetry ??
    this.segmentRetryAttempts;

  const cacheKey = buildParseHlsCacheKey(hlsUrl, headers);
  const cached = parseResultCache.get(cacheKey);
  if (cached) return cached;

  let fallbackCode: (typeof HlsDownloaderErrorCode)[keyof typeof HlsDownloaderErrorCode] =
    HlsDownloaderErrorCode.MANIFEST_FETCH_FAILED;
  try {
    let url = new URL(hlsUrl);

    const response = await fetchWithRetry({
      url: url.href,
      init: { headers, mode: 'cors', signal },
      maxAttempts: maxRetry,
      errorCode: HlsDownloaderErrorCode.MANIFEST_FETCH_FAILED,
      adapter: this.name,
    });
    url = new URL(response.url || url.href);
    let manifest = await response.text();
    fallbackCode = HlsDownloaderErrorCode.MANIFEST_INVALID;

    const parser = new Parser();
    parser.push(manifest);
    parser.end();

    let path = hlsUrl;

    try {
      let pathBase = url.pathname.split('/');
      pathBase.pop();
      pathBase.push('{{URL}}');
      path = pathBase.join('/');
    } catch (perror) {
      console.error(`[Info] Path parse error`, perror);
    }

    let base = url.origin + path;

    const result = mapManifest(parser.manifest, base);
    parseResultCache.set(cacheKey, result);
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
  state: { visited: Set<string>; depth: number } = { visited: new Set(), depth: 0 },
): Promise<{ segments: Segment[]; resolvedUrl: string }> {
  const { url } = mergeFetchOptions(
    getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(adapter, options),
    options,
  );
  if (state.depth > 8 || state.visited.has(url)) {
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.MANIFEST_INVALID,
      state.depth > 8
        ? 'Master playlist recursion limit exceeded'
        : 'Master playlist cycle detected',
      { adapter: adapter.name, url },
    );
  }
  const visited = new Set(state.visited).add(url);
  const result = await parseHls.call(adapter, options as HlsDownloaderFetchOptions);

  if (result.type === 'segment') {
    const fetchOptions = mergeFetchOptions(
      getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(adapter, options),
      options,
    );
    const segments = result.data as Segment[];
    assertSupportedSegments(segments, adapter.name);
    return { segments, resolvedUrl: fetchOptions.url };
  }

  if (result.type === 'playlist') {
    const variant = (options as { variant?: VariantSelectOptions }).variant;
    const best = selectBestVariant(result.data as Playlist[], variant);
    if (!best) {
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.NO_VARIANT,
        'Empty master playlist: no variant available',
        { adapter: adapter.name },
      );
    }
    if (best.hasAlternateRenditions) {
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.TRANSMUX_FAILED,
        'Alternate renditions are not supported by this transmux path',
        { adapter: adapter.name, url },
      );
    }
    return resolveToSegments(
      adapter,
      { ...options, url: best.uri },
      {
        visited,
        depth: state.depth + 1,
      },
    );
  }

  throw (
    result.error ??
    new HlsDownloaderError(
      HlsDownloaderErrorCode.MANIFEST_INVALID,
      result.message ?? 'Failed to parse HLS',
      { adapter: adapter.name },
    )
  );
}

const getPosterUrl: HlsDownloaderBrowserAdapter['getPosterUrl'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const fetchOptions = mergeFetchOptions(
    getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options),
    options,
  );

  if (posterCache[fetchOptions.url]) {
    return posterCache[fetchOptions.url];
  }
  const { segments } = await resolveToSegments(this, { ...options, ...fetchOptions });
  const index = Math.min(Math.floor(segments.length * 0.25), segments.length - 1);
  const poster = await extractPosterFromSegmentUrl({
    segmentUrl: segments[index]!.uri,
    headers: fetchOptions.headers,
    signal: fetchOptions.signal,
  });
  posterCache[fetchOptions.url] = poster;
  return poster;
};

const download: HlsDownloaderBrowserAdapter['download'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
  const { url, headers, maxRetry, downloadConcurrency, transcode, signal } = mergeDownloadOptions(
    this,
    globalOptions,
    options,
  );

  emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);

  if (signal?.aborted) {
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
      adapter: this.name,
    });
  }

  const { segments, resolvedUrl } = await resolveToSegments(this, { ...options, url, headers });
  const segmentWithIndex = segments.map((s, i) => ({
    ...s,
    index: i,
  }));
  emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);

  const shouldTranscode = needsBrowserTranscode(transcode);

  if (!shouldTranscode) {
    const blobURL = await downloadAndTransmux({
      url: resolvedUrl,
      segments: segmentWithIndex,
      headers,
      maxRetry,
      downloadConcurrency,
      signal,
      onProgress: (completed) => {
        emitAdapterEvent(this, options, HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
          total: segments.length,
          completed,
        });
      },
      onMuxProgress: (completed) => {
        emitAdapterEvent(this, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
          total: segments.length,
          completed,
        });
      },
    });

    emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);

    return {
      blobURL,
      totalSegments: segments.length,
    };
  }

  const browserTranscode = assertBrowserTranscodeOptions(transcode);
  const result = await transcodeHls({
    url: resolvedUrl,
    transcode: browserTranscode,
    headers,
    maxRetry,
    signal,
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
  range?: { offset: number; length: number };
};

type DownloadAndTransmuxOptions = {
  url: string;
  segments: Array<Segment & { index: number }>;
  headers?: Record<string, string>;
  maxRetry: number;
  downloadConcurrency: number;
  signal?: AbortSignal;
  onProgress: (completed: number) => void;
  onMuxProgress: (completed: number) => void;
};

const downloadAndTransmux = async ({
  url,
  segments,
  headers,
  maxRetry,
  downloadConcurrency,
  signal,
  onProgress,
  onMuxProgress,
}: DownloadAndTransmuxOptions) => {
  const resources = await preloadHlsResources({
    playlistUrl: url,
    segments,
    headers,
    maxRetry,
    downloadConcurrency,
    signal,
    onProgress,
  });
  if (signal?.aborted) {
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
      adapter: 'BrowserAdapter',
      url,
    });
  }
  const { buffer } = await transmuxPreloadedToMp4(resources);
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
  const requestHeaders = new Headers(options.headers);
  if (options.range) {
    requestHeaders.set(
      'Range',
      `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`,
    );
  }
  const response = await fetchWithRetry({
    url: options.url,
    init: {
      method: 'GET',
      headers: requestHeaders,
      mode: 'cors',
      signal: options.signal,
    },
    maxAttempts: maxRetry,
    errorCode: HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
    segmentIndex,
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!options.range) return bytes;
  if (response.status === 206) {
    const expectedEnd = options.range.offset + options.range.length - 1;
    const contentRange = response.headers.get('content-range');
    const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i);
    if (
      bytes.byteLength !== options.range.length ||
      !match ||
      Number(match[1]) !== options.range.offset ||
      Number(match[2]) !== expectedEnd
    ) {
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
        'Range response does not match the requested byte range',
        { url: options.url, segmentIndex },
      );
    }
    return bytes;
  }
  const end = options.range.offset + options.range.length;
  if (response.status === 200 && bytes.byteLength >= end) {
    return bytes.slice(options.range.offset, end);
  }
  throw new HlsDownloaderError(
    HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
    `Server did not satisfy byte range request (status ${response.status})`,
    { url: options.url, status: response.status, segmentIndex },
  );
};

type PreloadHlsResourcesOptions = {
  playlistUrl: string;
  segments: Segment[];
  headers?: Record<string, string>;
  maxRetry: number;
  downloadConcurrency: number;
  signal?: AbortSignal;
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

async function fetchPlaylistText({
  maxRetry,
  ...options
}: DownloadFileOptions & { maxRetry: number }): Promise<string> {
  const response = await fetchWithRetry({
    url: options.url,
    init: { headers: options.headers, mode: 'cors', signal: options.signal },
    maxAttempts: maxRetry,
    errorCode: HlsDownloaderErrorCode.MANIFEST_FETCH_FAILED,
  });
  return await response.text();
}

async function preloadHlsResources({
  playlistUrl,
  segments,
  headers,
  maxRetry,
  downloadConcurrency,
  signal,
  onProgress,
}: PreloadHlsResourcesOptions): Promise<HlsWasmResources> {
  const mediaPlaylist = await fetchPlaylistText({
    url: playlistUrl,
    headers,
    maxRetry,
    signal,
  });
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
    texts: { [playlistUrl]: mediaPlaylist },
    bytes: fullBytes,
    ranges,
  };
}

const downloadToStream: HlsDownloaderBrowserAdapter['downloadToStream'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
  onChunk,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
  const { url, headers, maxRetry, downloadConcurrency, signal } = mergeDownloadOptions(
    this,
    globalOptions,
    options,
  );

  emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);

  if (signal?.aborted) {
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
      adapter: this.name,
    });
  }

  const wasmReady = ensureWasm();

  const { segments, resolvedUrl } = await resolveToSegments(this, { ...options, url, headers });
  emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);

  const [resources] = await Promise.all([
    preloadHlsResources({
      playlistUrl: resolvedUrl,
      segments,
      headers,
      maxRetry,
      downloadConcurrency,
      signal,
      onProgress: (completed) => {
        emitAdapterEvent(this, options, HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
          total: segments.length,
          completed,
        });
      },
    }),
    wasmReady,
  ]);

  await transmuxPreloadedToFmp4Stream(resources, (chunk) => {
    if (signal?.aborted) {
      throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
        adapter: this.name,
        url,
      });
    }
    onChunk(chunk);
  });
  emitAdapterEvent(this, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
    total: segments.length,
    completed: segments.length,
  });

  emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
  return { totalSegments: segments.length };
};

const downloadToWritable: NonNullable<HlsDownloaderBrowserAdapter['downloadToWritable']> =
  async function (this: HlsDownloaderBrowserAdapter, options, write) {
    const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
    // This path never merges global transcode settings.
    const { url, headers } = mergeFetchOptions(globalOptions, options);
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
      emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
      const {
        playlist,
        url: resolvedUrl,
        segments,
      } = await resolveWritablePlaylist({
        ...options,
        url,
        headers,
        maxRetry,
        signal,
      });
      emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
      window = createResourceWindow(
        segments,
        concurrency,
        guard(async (resource) => (await readResource(resource, headers, maxRetry, signal)).bytes),
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
  },
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  getPosterUrl,
  download,
  downloadToStream,
  downloadToWritable,
  clearCache: () => parseResultCache.clear(),
}) as HlsDownloaderBrowserAdapter;

export const BrowserAdapter: HlsDownloaderBrowserAdapter = browserAdapter;

export default BrowserAdapter;
