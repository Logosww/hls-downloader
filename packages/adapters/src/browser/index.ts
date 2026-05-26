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
  buildBrowserFfmpegOutputArgs,
  assertBrowserTranscodeOptions,
  getDownloadOutputFilename,
  needsBrowserFfmpegTranscode,
  type HlsDownloaderBrowserTranscodeOptions,
  type ParseHlsResult,
  type Playlist,
  type Segment,
} from '@hls-downloader/shared';
import { FFMessageLoadConfig, FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { transmuxHlsToMp4Buffer } from './mediabunny';
import { extractPosterFromSegmentUrl } from './poster';
import { fakeDelay, promiseWithLimit } from './utils';

/**
 * @internal
 */
declare global {
  const __FFmpeg_Base__: string;
  const __FFmpeg_Mt_Base__: string;
}

type DownloadResult = {
  blobURL: string;
  totalSegments: number;
};

export type BrowserAdapterFfmpegOptions = {
  coreURL?: string;
  wasmURL?: string;
  workerURL?: string;
  disableMultiThread?: boolean;
  useESM?: boolean;
};

type BrowserAdditionalOptions = {
  ffmpeg?: BrowserAdapterFfmpegOptions;
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
    ffmpeg: callOptions.ffmpeg ?? globalOptions?.ffmpeg,
  };
}

let ffmpeg: FFmpeg | null = null;
let ffmpegOptions: BrowserAdapterFfmpegOptions | undefined;
const parseResultCache: Record<string, ParseHlsResult> = Object.create(null);
const posterCache: Record<string, string | undefined> = Object.create(null);

const init: HlsDownloaderBrowserAdapter['init'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(
    this,
    options ?? undefined,
  );
  ffmpegOptions = globalOptions?.ffmpeg;
};

async function ensureFfmpegLoaded(
  adapter: HlsDownloaderBrowserAdapter,
  options?: BrowserAdapterFfmpegOptions,
) {
  ffmpegOptions = { ...ffmpegOptions, ...options };
  ffmpeg = ffmpeg ?? new FFmpeg();
  if (!ffmpeg.loaded) {
    adapter.onEvent?.(HlsDownloaderEvent.FFMPEG_LOADING);
    const multiThreadAvailable =
      typeof globalThis.crossOriginIsolated !== 'undefined' &&
      globalThis.crossOriginIsolated &&
      typeof SharedArrayBuffer !== 'undefined';
    const useMultiThread = !ffmpegOptions?.disableMultiThread && multiThreadAvailable;
    const FFmpegBase = useMultiThread ? __FFmpeg_Mt_Base__ : __FFmpeg_Base__;
    const shouldUseESM = ffmpegOptions?.useESM ?? false;
    const loadOption: FFMessageLoadConfig = {
      coreURL:
        ffmpegOptions?.coreURL ??
        (await toBlobURL(
          `${FFmpegBase}/${shouldUseESM ? 'esm' : 'umd'}/ffmpeg-core.js`,
          'text/javascript',
        )),
      wasmURL:
        ffmpegOptions?.wasmURL ??
        (await toBlobURL(
          `${FFmpegBase}/${shouldUseESM ? 'esm' : 'umd'}/ffmpeg-core.wasm`,
          'application/wasm',
        )),
      workerURL: useMultiThread
        ? (ffmpegOptions?.workerURL ??
          (await toBlobURL(
            `${FFmpegBase}/${shouldUseESM ? 'esm' : 'umd'}/ffmpeg-core.worker.js`,
            'text/javascript',
          )))
        : void 0,
    };
    await ffmpeg.load(loadOption);
    adapter.onEvent?.(HlsDownloaderEvent.FFMPEG_LOADED);
  }
}

const parseHls: HlsDownloaderBrowserAdapter['parseHls'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const { url: hlsUrl, headers } = mergeFetchOptions(
    getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options),
    options,
  );

  try {
    let url = new URL(hlsUrl);

    let response = await fetch(url.href, { headers, mode: 'cors' });
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
  });
  posterCache[fetchOptions.url] = poster;
  return poster;
};

const download: HlsDownloaderBrowserAdapter['download'] = async function (
  this: HlsDownloaderBrowserAdapter,
  options,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
  const { url, headers, filename, maxRetry, downloadConcurrency, transcode, ffmpeg: ffmpegLoadOptions } =
    mergeDownloadOptions(this, globalOptions, options);

  this.onEvent?.(HlsDownloaderEvent.STARTING_DOWNLOAD);

  const { segments } = await resolveToSegments(this, { ...options, url, headers });
  const segmentWithIndex = segments.map((s, i) => ({
    ...s,
    index: i,
  }));
  this.onEvent?.(HlsDownloaderEvent.SOURCE_PARSED);
  await fakeDelay(1500);

  const shouldUseFfmpeg = needsBrowserFfmpegTranscode(transcode);

  if (!shouldUseFfmpeg) {
    const blobURL = await downloadAndTransmux({
      url,
      segments: segmentWithIndex,
      headers,
      maxRetry,
      downloadConcurrency,
      onProgress: (completed) => {
        this.onEvent?.(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
          total: segments.length,
          completed,
        });
      },
      onMuxProgress: (completed) => {
        this.onEvent?.(HlsDownloaderEvent.STICHING_SEGMENTS, {
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

  if (!ffmpeg?.loaded) {
    await ensureFfmpegLoaded(this, ffmpegLoadOptions);
  }
  if (!ffmpeg) {
    throw new Error('FFmpeg is not initialized');
  }

  assertBrowserTranscodeOptions(transcode!);

  let completed = 0;

  const downloadedSegments = await promiseWithLimit(
    segmentWithIndex.map((segment) => async () => {
      const filePath = await downloadAndWriteFileWithRetry({
        url: segment.uri,
        headers,
        fileIndex: segment.index,
        maxRetry,
      });

      this.onEvent?.(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
        total: segments.length,
        completed: completed++,
      });

      return {
        segment,
        filePath: filePath!,
      };
    }),
    downloadConcurrency,
  );

  ffmpeg.on('progress', ({ progress }) => {
    this.onEvent?.(HlsDownloaderEvent.STICHING_SEGMENTS, {
      total: 100,
      completed: Math.floor(progress * 100),
    });
  });

  await ffmpeg.exec([
    '-i',
    `concat:${downloadedSegments.map((s) => s.filePath).join('|')}`,
    ...buildBrowserFfmpegOutputArgs(),
    filename,
  ]);

  const data = await ffmpeg.readFile(filename);
  const blobData = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);

  this.onEvent?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);

  const blobURL = URL.createObjectURL(new Blob([blobData], { type: 'video/mp4' }));

  return {
    blobURL,
    totalSegments: segments.length,
  };
};

type DownloadFileOptions = {
  url: string;
  fileIndex: number;
  headers?: Record<string, string>;
};

const downloadSegmentBytes = async ({ url, headers }: Omit<DownloadFileOptions, 'fileIndex'>) => {
  const response = await fetch(url, {
    method: 'GET',
    headers: headers,
    mode: 'cors',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
};

const downloadAndWriteFile = async ({ url, fileIndex, headers }: DownloadFileOptions) => {
  if (!ffmpeg?.loaded) {
    throw new Error('FFmpeg is not initialized');
  }

  const unit8Array = await downloadSegmentBytes({ url, headers });

  const filePath = `${fileIndex}.ts`;

  await ffmpeg.writeFile(filePath, unit8Array);

  return filePath;
};

const downloadAndWriteFileWithRetry = async ({
  maxRetry,
  ...options
}: DownloadFileOptions & {
  maxRetry: number;
}) => {
  let retry = 0;

  while (retry < maxRetry) {
    try {
      return await downloadAndWriteFile(options);
    } catch {
      retry++;
      if (retry >= maxRetry) {
        throw new Error(`Failed to download ${options.url} after ${maxRetry} attempts`);
      }
    }
  }
};

type DownloadAndTransmuxOptions = {
  url: string;
  segments: Array<Segment & { index: number }>;
  headers?: Record<string, string>;
  maxRetry: number;
  downloadConcurrency: number;
  onProgress: (completed: number) => void;
  onMuxProgress: (completed: number) => void;
};

const downloadAndTransmux = async ({
  url,
  segments,
  headers,
  onProgress,
  onMuxProgress,
}: DownloadAndTransmuxOptions) => {
  const buffer = await transmuxHlsToMp4Buffer({
    url,
    headers,
    segmentUrls: segments.map((segment) => segment.uri),
    onSegmentLoaded: onProgress,
  });
  onMuxProgress(segments.length);

  return URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
};

const downloadSegmentBytesWithRetry = async ({
  maxRetry,
  ...options
}: Omit<DownloadFileOptions, 'fileIndex'> & {
  maxRetry: number;
}) => {
  let retry = 0;

  while (retry < maxRetry) {
    try {
      return await downloadSegmentBytes(options);
    } catch {
      retry++;
      if (retry >= maxRetry) {
        throw new Error(`Failed to download ${options.url} after ${maxRetry} attempts`);
      }
    }
  }

  throw new Error(`Failed to download ${options.url}`);
};

const browserAdapter: HlsDownloaderBrowserAdapter = createAdapter({
  name: 'BrowserAdapter',
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  getPosterUrl,
  download,
}) as HlsDownloaderBrowserAdapter;

export const BrowserAdapter: HlsDownloaderBrowserAdapter = browserAdapter;

/**
 * @deprecated Use `BrowserAdapter` instead.
 */
export const WasmAdapter: HlsDownloaderBrowserAdapter = browserAdapter;

/**
 * @deprecated Use `HlsDownloaderBrowserAdapter` instead.
 */
export type HlsDownloaderWasmAdapter = HlsDownloaderBrowserAdapter;

export default BrowserAdapter;
