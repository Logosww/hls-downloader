import { Parser } from 'm3u8-parser';
import {
  createAdapter,
  getAdapterGlobalOptionsFromInternal,
  HlsDownloaderEvent,
  selectBestVariant,
  stripContext,
  type HlsDownloaderAdapterInternal,
  type HlsDownloaderDownloadOptions,
  type HlsDownloaderFetchOptions,
  type HlsDownloaderGlobalDownloadOptions,
  assertBrowserTranscodeOptions,
  getDownloadOutputFilename,
  needsBrowserTranscode,
  type HlsDownloaderBrowserTranscodeOptions,
  type ParseHlsResult,
  type Playlist,
  type Segment,
} from '@hls-downloader/shared';
import { transcodeHls } from './mediabunny';
import { extractPosterFromSegmentUrl } from './poster';
import { promiseWithLimit } from './utils';
import {
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

const parseResultCache: Record<string, ParseHlsResult> = Object.create(null);
const posterCache: Record<string, string | undefined> = Object.create(null);

const init: HlsDownloaderBrowserAdapter['init'] = async function () {};

const parseHls: HlsDownloaderBrowserAdapter['parseHls'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const {
    url: hlsUrl,
    headers,
    signal,
  } = mergeFetchOptions(
    getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options),
    options,
  );

  try {
    let url = new URL(hlsUrl);

    let response = await fetch(url.href, { headers, mode: 'cors', signal });
    if (!response.ok) throw new Error(await response.text());
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

    if (parser.manifest.playlists?.length) {
      const groups = parser.manifest.playlists
        .map((g: any) => {
          return {
            name: g.attributes.NAME
              ? g.attributes.NAME
              : g.attributes.RESOLUTION
                ? `${g.attributes.RESOLUTION.width}x${g.attributes.RESOLUTION.height}`
                : `MAYBE_AUDIO:${g.attributes.BANDWIDTH}`,
            bandwidth: g.attributes.BANDWIDTH,
            uri: g.uri.startsWith('http') ? g.uri : base.replace('{{URL}}', g.uri),
          } as Playlist;
        })
        .filter((g: Playlist | null) => g);

      const result: ParseHlsResult = {
        type: 'playlist',
        data: groups,
      };
      parseResultCache[hlsUrl] = result;
      return result;
    } else if (parser.manifest.segments?.length) {
      let segments = parser.manifest.segments;
      segments = segments.map((s: any) => ({
        ...s,
        uri: s.uri.startsWith('http') ? s.uri : base.replace('{{URL}}', s.uri),
      }));

      const result: ParseHlsResult = {
        type: 'segment',
        data: segments,
      };
      parseResultCache[hlsUrl] = result;
      return result;
    }

    throw new Error('No playlists or segments found');
  } catch (error: any) {
    const result: ParseHlsResult = {
      type: 'error',
      message: error.message,
    };
    parseResultCache[hlsUrl] = result;
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
    const best = selectBestVariant(result.data as Playlist[]);
    if (!best) throw new Error('Empty master playlist: no variant available');
    return resolveToSegments(adapter, { ...options, url: best.uri });
  }

  throw new Error(result.message ?? 'Failed to parse HLS');
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

  this.onEvent?.(HlsDownloaderEvent.STARTING_DOWNLOAD);

  if (signal?.aborted) {
    const err = new Error('Download aborted');
    err.name = 'AbortError';
    throw err;
  }

  const { segments, resolvedUrl } = await resolveToSegments(this, { ...options, url, headers });
  const segmentWithIndex = segments.map((s, i) => ({
    ...s,
    index: i,
  }));
  this.onEvent?.(HlsDownloaderEvent.SOURCE_PARSED);

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
        this.onEvent?.(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
          total: segments.length,
          completed,
        });
      },
      onMuxProgress: (completed) => {
        this.onEvent?.(HlsDownloaderEvent.STITCHING_SEGMENTS, {
          total: segments.length,
          completed,
        });
      },
    });

    this.onEvent?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);

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
    signal,
    segmentUrls: segments.map((segment) => segment.uri),
    onSegmentLoaded: (completed) => {
      this.onEvent?.(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
        total: segments.length,
        completed,
      });
    },
    onProgress: (progress) => {
      this.onEvent?.(HlsDownloaderEvent.STITCHING_SEGMENTS, {
        total: 100,
        completed: Math.floor(progress * 100),
      });
    },
  });

  this.onEvent?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);

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

const downloadSegmentBytes = async ({ url, headers, signal }: DownloadFileOptions) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: headers,
    mode: 'cors',
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
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
    const error = new Error('Download aborted');
    error.name = 'AbortError';
    throw error;
  }
  const { buffer } = await transmuxPreloadedToMp4(resources);
  onMuxProgress(segments.length);

  return URL.createObjectURL(new Blob([Uint8Array.from(buffer).buffer], { type: 'video/mp4' }));
};

const downloadSegmentBytesWithRetry = async ({
  maxRetry,
  ...options
}: DownloadFileOptions & {
  maxRetry: number;
}) => {
  let retry = 0;

  while (retry < maxRetry) {
    try {
      return await downloadSegmentBytes(options);
    } catch {
      if (options.signal?.aborted) {
        const abortErr = new Error('Download aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      retry++;
      if (retry >= maxRetry) {
        throw new Error(`Failed to download ${options.url} after ${maxRetry} attempts`);
      }
    }
  }

  throw new Error(`Failed to download ${options.url}`);
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
  let retry = 0;
  while (retry < maxRetry) {
    try {
      const response = await fetch(options.url, {
        headers: options.headers,
        mode: 'cors',
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`Failed to fetch ${options.url}`);
      return await response.text();
    } catch {
      if (options.signal?.aborted) {
        const error = new Error('Download aborted');
        error.name = 'AbortError';
        throw error;
      }
      retry++;
      if (retry >= maxRetry) {
        throw new Error(`Failed to download ${options.url} after ${maxRetry} attempts`);
      }
    }
  }
  throw new Error(`Failed to download ${options.url}`);
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
  const resourceUrls = new Set<string>();

  for (const segment of segments) {
    const [segmentUrl, ...additionalUrls] = getSegmentResourceUrls(segment, playlistUrl);
    if (!segmentUrl) continue;
    segmentCounts.set(segmentUrl, (segmentCounts.get(segmentUrl) ?? 0) + 1);
    resourceUrls.add(segmentUrl);
    for (const resourceUrl of additionalUrls) resourceUrls.add(resourceUrl);
  }

  let completed = 0;
  const entries = await promiseWithLimit(
    [...resourceUrls].map((resourceUrl) => async () => {
      const bytes = await downloadSegmentBytesWithRetry({
        url: resourceUrl,
        headers,
        maxRetry,
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

  this.onEvent?.(HlsDownloaderEvent.STARTING_DOWNLOAD);

  if (signal?.aborted) {
    const err = new Error('Download aborted');
    err.name = 'AbortError';
    throw err;
  }

  const { segments, resolvedUrl } = await resolveToSegments(this, { ...options, url, headers });
  this.onEvent?.(HlsDownloaderEvent.SOURCE_PARSED);

  const resources = await preloadHlsResources({
    playlistUrl: resolvedUrl,
    segments,
    headers,
    maxRetry,
    downloadConcurrency,
    signal,
    onProgress: (completed) => {
      this.onEvent?.(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
        total: segments.length,
        completed,
      });
    },
  });

  await transmuxPreloadedToFmp4Stream(resources, (chunk) => {
    if (signal?.aborted) {
      const error = new Error('Download aborted');
      error.name = 'AbortError';
      throw error;
    }
    onChunk(chunk);
  });
  this.onEvent?.(HlsDownloaderEvent.STITCHING_SEGMENTS, {
    total: segments.length,
    completed: segments.length,
  });

  this.onEvent?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);
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
}) as HlsDownloaderBrowserAdapter;

export const BrowserAdapter: HlsDownloaderBrowserAdapter = browserAdapter;

export default BrowserAdapter;
