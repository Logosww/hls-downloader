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
  type HlsDownloaderTranscodeOptions,
  needsFfmpegTranscode,
  buildFfmpegOutputArgs,
  getDownloadOutputFilename,
  type ParseHlsResult,
  type Playlist,
  type Segment,
} from '@hls-downloader/shared';
import {
  initFfmpeg,
  parseHlsNative,
  downloadAndMerge,
  extractPoster,
  transmuxHlsNative,
  type NapiParseHlsResult,
  type NapiAria2Config,
} from './native.js';
import { extractPosterFromSegmentUrl } from './poster';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type NodeAdapterAria2Options = NapiAria2Config;
/**
 * @deprecated Use `NodeAdapterAria2Options` instead.
 */
export type RustAdapterAria2Options = NodeAdapterAria2Options;
type AdditionalOptions = {
  aria2?: NodeAdapterAria2Options;
};
type DownloadResult = {
  filePath: string;
  totalSegments: number;
};
export type HlsDownloaderNodeAdapter = HlsDownloaderAdapterInternal<
  AdditionalOptions,
  DownloadResult
>;

type NodeGlobalOptions = {
  download?: HlsDownloaderGlobalDownloadOptions;
  transcode?: HlsDownloaderTranscodeOptions;
} & AdditionalOptions;

function mergeFetchOptions(
  globalOptions: NodeGlobalOptions | null,
  options: Record<string, unknown>,
): HlsDownloaderFetchOptions {
  const callOptions = stripContext(options) as HlsDownloaderFetchOptions;

  return {
    headers: globalOptions?.download?.headers,
    ...callOptions,
  };
}

function mergeDownloadOptions(
  adapter: HlsDownloaderNodeAdapter,
  globalOptions: NodeGlobalOptions | null,
  options: Record<string, unknown>,
) {
  const callOptions = stripContext(options) as HlsDownloaderFetchOptions &
    HlsDownloaderDownloadOptions &
    AdditionalOptions;
  const transcode = callOptions.transcode ?? globalOptions?.transcode;

  return {
    url: callOptions.url,
    headers: callOptions.headers ?? globalOptions?.download?.headers,
    filename: getDownloadOutputFilename(callOptions.filename, transcode),
    maxRetry:
      callOptions.maxRetry ?? globalOptions?.download?.maxRetry ?? adapter.segmentRetryAttempts,
    downloadConcurrency:
      callOptions.downloadConcurrency ??
      globalOptions?.download?.concurrency ??
      adapter.chunkDownloadConcurrency,
    transcode,
    aria2: callOptions.aria2 ?? globalOptions?.aria2,
  };
}

let ffmpegInitialized = false;
const parseResultCache: Record<string, ParseHlsResult> = Object.create(null);
const posterCache: Record<string, string | undefined> = Object.create(null);

function toParseHlsResult(napi: NapiParseHlsResult): ParseHlsResult {
  switch (napi.resultType) {
    case 'playlist':
      return {
        type: 'playlist',
        data: (napi.playlists ?? []).map((p) => ({
          name: p.name,
          bandwidth: p.bandwidth,
          uri: p.uri,
        })),
      };
    case 'segment':
      return {
        type: 'segment',
        data: (napi.segments ?? []).map((s) => ({
          uri: s.uri,
          duration: s.duration,
        })),
      };
    default:
      return { type: 'error', message: napi.message ?? 'Unknown error' };
  }
}

const init: HlsDownloaderNodeAdapter['init'] = async function () {
  // FFmpeg is loaded only by APIs that need it.
};

function ensureFfmpegLoaded(adapter: HlsDownloaderNodeAdapter) {
  if (ffmpegInitialized) return;
  adapter.onEvent?.(HlsDownloaderEvent.FFMPEG_LOADING);
  initFfmpeg();
  ffmpegInitialized = true;
  adapter.onEvent?.(HlsDownloaderEvent.FFMPEG_LOADED);
}

const parseHls: HlsDownloaderNodeAdapter['parseHls'] = async function (
  this: HlsDownloaderNodeAdapter,
  options,
) {
  const { url, headers } = mergeFetchOptions(
    getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options),
    options,
  );

  if (parseResultCache[url]) return parseResultCache[url];

  const napiResult = await parseHlsNative(url, headers);
  const result = toParseHlsResult(napiResult);
  parseResultCache[url] = result;
  return result;
};

async function resolveToSegments(
  adapter: HlsDownloaderNodeAdapter,
  options: Record<string, unknown>,
): Promise<{ segments: Segment[]; resolvedUrl: string }> {
  const result = await parseHls.call(adapter, options as HlsDownloaderFetchOptions);

  if (result.type === 'segment') {
    const fetchOptions = mergeFetchOptions(
      getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(adapter, options),
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

const getPosterUrl: HlsDownloaderNodeAdapter['getPosterUrl'] = async function (
  this: HlsDownloaderNodeAdapter,
  options,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options);
  const fetchOptions = mergeFetchOptions(globalOptions, options);

  if (posterCache[fetchOptions.url]) {
    return posterCache[fetchOptions.url];
  }
  const { segments } = await resolveToSegments(this, { ...options, ...fetchOptions });
  const index = Math.min(Math.floor(segments.length * 0.25), segments.length - 1);
  const segmentUrl = segments[index]!.uri;

  // 直接使用 ffmpeg 截取海报。
  // MediaBunny CanvasSink 需要 VideoEncoder 和 OffscreenCanvas 支持，
  // 而 Node/Bun 服务端目前缺少这些 API，引入 @mediabunny/server polyfill 则体积过大。
  // 等后续 Node/Bun 运行时原生完善支持后再考虑切换回 MediaBunny 方案。
  ensureFfmpegLoaded(this);
  const poster = (await extractPoster(segmentUrl, fetchOptions.headers)) ?? undefined;

  posterCache[fetchOptions.url] = poster;
  return poster;
};

const download: HlsDownloaderNodeAdapter['download'] = async function (
  this: HlsDownloaderNodeAdapter,
  options,
): Promise<DownloadResult> {
  const globalOptions = getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options);
  const { url, headers, filename, maxRetry, downloadConcurrency, aria2, transcode } =
    mergeDownloadOptions(this, globalOptions, options);

  this.onEvent?.(HlsDownloaderEvent.STARTING_DOWNLOAD);

  const { segments } = await resolveToSegments(this, { ...options, url, headers });
  this.onEvent?.(HlsDownloaderEvent.SOURCE_PARSED);

  const workDir = join(process.cwd(), randomUUID());
  await mkdir(workDir, { recursive: true });
  const napiSegments = segments.map((s) => ({ uri: s.uri, duration: s.duration ?? 0 }));

  const transcodeArgs = needsFfmpegTranscode(transcode) ? buildFfmpegOutputArgs(transcode) : null;
  const shouldUseFfmpeg = !!transcodeArgs || aria2?.enabled;

  if (!shouldUseFfmpeg) {
    const filePath = await downloadAndTransmux({
      segments,
      workDir,
      filename,
      headers,
      downloadConcurrency,
      maxRetry,
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
      filePath,
      totalSegments: segments.length,
    };
  }

  ensureFfmpegLoaded(this);
  const self = this;
  const filePath = await downloadAndMerge(
    napiSegments,
    workDir,
    filename,
    headers,
    downloadConcurrency,
    maxRetry,
    aria2 ?? null,
    transcodeArgs,
    (phase: string, completed: number, total: number) => {
      if (phase === 'downloading') {
        self.onEvent?.(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, { total, completed });
      } else if (phase === 'merging') {
        self.onEvent?.(HlsDownloaderEvent.STICHING_SEGMENTS, { total, completed });
      }
    },
  );

  this.onEvent?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);

  return {
    filePath: filePath,
    totalSegments: segments.length,
  };
};

type DownloadAndTransmuxOptions = {
  segments: Segment[];
  workDir: string;
  filename: string;
  headers?: Record<string, string>;
  downloadConcurrency: number;
  maxRetry: number;
  onProgress: (completed: number) => void;
  onMuxProgress: (completed: number) => void;
};

async function downloadAndTransmux({
  segments,
  workDir,
  filename,
  headers,
  downloadConcurrency,
  maxRetry,
  onProgress,
  onMuxProgress,
}: DownloadAndTransmuxOptions) {
  const napiSegments = segments.map((s) => ({ uri: s.uri, duration: s.duration ?? 0 }));
  const buffer = await transmuxHlsNative(
    napiSegments,
    headers ?? null,
    downloadConcurrency,
    maxRetry,
    onProgress,
  );
  onMuxProgress(segments.length);

  const filePath = join(workDir, filename);
  await writeFile(filePath, buffer);
  return filePath;
}

const nodeAdapter: HlsDownloaderNodeAdapter = createAdapter({
  name: 'NodeAdapter',
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  getPosterUrl,
  download,
}) as HlsDownloaderNodeAdapter;

export const NodeAdapter: HlsDownloaderNodeAdapter = nodeAdapter;

/**
 * @deprecated Use `NodeAdapter` instead.
 */
export const RustAdapter: HlsDownloaderNodeAdapter = nodeAdapter;

/**
 * @deprecated Use `HlsDownloaderNodeAdapter` instead.
 */
export type HlsDownloaderRustAdapter = HlsDownloaderNodeAdapter;

export default NodeAdapter;
