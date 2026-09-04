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
} from '@hls-downloader/shared';
import { transcodeHls } from './mediabunny';
import { extractPosterFromSegmentUrl } from './poster';
import { promiseWithLimit } from './utils';
import { fetchWithRetry } from './retry';
import {
  ensureWasm,
  transmuxPreloadedToFmp4Stream,
  transmuxPreloadedToMp4,
  type HlsWasmResources,
} from './wasm';

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
    const error = normalizeHlsError(cause, HlsDownloaderErrorCode.MANIFEST_FETCH_FAILED, {
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
): Promise<{ segments: Segment[]; resolvedUrl: string }> {
  const result = await parseHls.call(adapter, options as HlsDownloaderFetchOptions);

  if (result.type === 'segment') {
    const fetchOptions = mergeFetchOptions(
      getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(adapter, options),
      options,
    );
    return { segments: result.data as Segment[], resolvedUrl: fetchOptions.url };
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
    return resolveToSegments(adapter, { ...options, url: best.uri });
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
  const response = await fetchWithRetry({
    url: options.url,
    init: {
      method: 'GET',
      headers: options.headers,
      mode: 'cors',
      signal: options.signal,
    },
    maxAttempts: maxRetry,
    errorCode: HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
    segmentIndex,
  });
  return new Uint8Array(await response.arrayBuffer());
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

function getSegmentResourceUrls(segment: Segment, playlistUrl: string): string[] {
  const urls = [segment.uri];
  if (typeof segment.key?.uri === 'string') urls.push(segment.key.uri);
  if (typeof segment.map?.uri === 'string') urls.push(segment.map.uri);
  return urls.map((url) => resolveResourceUrl(url, playlistUrl));
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
  const resourceUrls = new Set<string>();

  for (const [segmentIndex, segment] of segments.entries()) {
    const [segmentUrl, ...additionalUrls] = getSegmentResourceUrls(segment, playlistUrl);
    if (!segmentUrl) continue;
    segmentCounts.set(segmentUrl, (segmentCounts.get(segmentUrl) ?? 0) + 1);
    resourceUrls.add(segmentUrl);
    resourceSegmentIndexes.set(segmentUrl, segmentIndex);
    for (const resourceUrl of additionalUrls) {
      resourceUrls.add(resourceUrl);
      if (!resourceSegmentIndexes.has(resourceUrl)) {
        resourceSegmentIndexes.set(resourceUrl, segmentIndex);
      }
    }
  }

  let completed = 0;
  const entries = await promiseWithLimit(
    [...resourceUrls].map((resourceUrl) => async () => {
      const bytes = await downloadSegmentBytesWithRetry({
        url: resourceUrl,
        headers,
        maxRetry,
        segmentIndex: resourceSegmentIndexes.get(resourceUrl),
        signal,
      });
      completed += segmentCounts.get(resourceUrl) ?? 0;
      if (segmentCounts.has(resourceUrl)) onProgress(completed);
      return [resourceUrl, bytes] as const;
    }),
    downloadConcurrency,
  );

  return {
    playlistUrl,
    texts: { [playlistUrl]: mediaPlaylist },
    bytes: Object.fromEntries(entries),
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

const browserAdapter: HlsDownloaderBrowserAdapter = createAdapter({
  name: 'BrowserAdapter',
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  getPosterUrl,
  download,
  downloadToStream,
  clearCache: () => parseResultCache.clear(),
}) as HlsDownloaderBrowserAdapter;

export const BrowserAdapter: HlsDownloaderBrowserAdapter = browserAdapter;

export default BrowserAdapter;
