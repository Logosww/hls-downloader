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
  transmuxHlsStreamingNative,
  createCancelToken,
  cancelJob,
  type NapiParseHlsResult,
  type NapiAria2Config,
} from './native.js';
import { extractPosterFromSegmentUrl } from './poster';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type NodeAdapterAria2Options = NapiAria2Config;
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
    signal: callOptions.signal,
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
  const { url, headers, filename, maxRetry, downloadConcurrency, aria2, transcode, signal } =
    mergeDownloadOptions(this, globalOptions, options);

  this.onEvent?.(HlsDownloaderEvent.STARTING_DOWNLOAD);

  if (signal?.aborted) {
    const err = new Error('Download aborted');
    err.name = 'AbortError';
    throw err;
  }

  const { segments, resolvedUrl } = await resolveToSegments(this, { ...options, url, headers });
  this.onEvent?.(HlsDownloaderEvent.SOURCE_PARSED);

  const workDir = join(process.cwd(), randomUUID());
  await mkdir(workDir, { recursive: true });
  const napiSegments = segments.map((s) => ({ uri: s.uri, duration: s.duration ?? 0 }));

  const transcodeArgs = needsFfmpegTranscode(transcode) ? buildFfmpegOutputArgs(transcode) : null;
  const shouldUseFfmpeg = !!transcodeArgs || aria2?.enabled;

  if (!shouldUseFfmpeg) {
    const { jobId, cleanup } = await setupCancelToken(signal);
    try {
      const filePath = await downloadAndTransmux({
        resolvedUrl,
        workDir,
        filename,
        headers,
        downloadConcurrency,
        maxRetry,
        cancelJobId: jobId,
        onProgress: (completed, total) => {
          this.onEvent?.(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
            total,
            completed,
          });
        },
        onMuxProgress: (completed, total) => {
          this.onEvent?.(HlsDownloaderEvent.STITCHING_SEGMENTS, {
            total,
            completed,
          });
        },
      });

      this.onEvent?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);

      return {
        filePath,
        totalSegments: segments.length,
      };
    } finally {
      cleanup();
    }
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
        self.onEvent?.(HlsDownloaderEvent.STITCHING_SEGMENTS, { total, completed });
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
  resolvedUrl: string;
  workDir: string;
  filename: string;
  headers?: Record<string, string>;
  downloadConcurrency: number;
  maxRetry: number;
  cancelJobId?: string | null;
  onProgress: (completed: number, total: number) => void;
  onMuxProgress: (completed: number, total: number) => void;
};

/**
 * 为一次下载任务创建取消令牌。若 signal 已中止则立即抛出 AbortError；
 * 否则注册 abort 监听器，触发时调用 cancelJob 通知 Rust 端。
 * 返回 cleanup 函数用于在任务结束（成功或失败）后移除监听器并清理注册表。
 */
async function setupCancelToken(
  signal?: AbortSignal,
): Promise<{ jobId: string | null; cleanup: () => void }> {
  if (!signal) return { jobId: null, cleanup: () => {} };

  if (signal.aborted) {
    const err = new Error('Download aborted');
    err.name = 'AbortError';
    throw err;
  }

  const jobId = await createCancelToken();
  const onAbort = () => {
    cancelJob(jobId).catch(() => {});
  };
  signal.addEventListener('abort', onAbort, { once: true });

  return {
    jobId,
    cleanup: () => {
      signal.removeEventListener('abort', onAbort);
      cancelJob(jobId).catch(() => {});
    },
  };
}

async function downloadAndTransmux({
  resolvedUrl,
  workDir,
  filename,
  headers,
  downloadConcurrency,
  maxRetry,
  cancelJobId,
  onProgress,
  onMuxProgress,
}: DownloadAndTransmuxOptions) {
  // hls-transmux 的 StreamingMp4 路径下，下载与 mux 是流式交织进行的，
  // 单一 on_progress 同时反映下载与 mux 进度。这里把进度映射到
  // DOWNLOADING_SEGMENTS 事件；末端完成时由 onMuxProgress 触发一次
  // STITCHING_SEGMENTS 满 progress，保持原两阶段事件语义。
  const filePath = await transmuxHlsNative(
    resolvedUrl,
    workDir,
    filename,
    headers ?? null,
    downloadConcurrency,
    maxRetry,
    cancelJobId ?? null,
    onProgress,
  );
  onMuxProgress(1, 1);
  return filePath;
}

const downloadToStream: HlsDownloaderNodeAdapter['downloadToStream'] = async function (
  this,
  options,
  onChunk,
) {
  const globalOptions = getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options);
  const { url, headers, downloadConcurrency, maxRetry, signal } = mergeDownloadOptions(
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

  // 流式路径只需 resolvedUrl（media playlist URL），不需要 segments
  const { resolvedUrl } = await resolveToSegments(this, { ...options, url, headers });
  this.onEvent?.(HlsDownloaderEvent.SOURCE_PARSED);

  // totalSegments：从 segments 长度取，传给上层进度 UI
  const result = await parseHls.call(this, { url: resolvedUrl, headers });
  const totalSegments = result.type === 'segment' ? result.data.length : 0;

  const { jobId, cleanup } = await setupCancelToken(signal);
  try {
    await transmuxHlsStreamingNative(
      resolvedUrl,
      headers ?? null,
      downloadConcurrency,
      maxRetry,
      jobId,
      // ThreadsafeFunction 默认 CalleeHandled=true，callback 签名为 (err, value)
      (err: Error | null, bytes: Buffer) => {
        if (err) return;
        onChunk(new Uint8Array(bytes));
      },
      (err: Error | null, completed: number, total: number) => {
        if (err) return;
        this.onEvent?.(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, { total, completed });
      },
    );
  } finally {
    cleanup();
  }

  // 末端触发 STITCHING_SEGMENTS + READY_FOR_DOWNLOAD，保持事件语义一致
  this.onEvent?.(HlsDownloaderEvent.STITCHING_SEGMENTS, {
    total: totalSegments,
    completed: totalSegments,
  });
  this.onEvent?.(HlsDownloaderEvent.READY_FOR_DOWNLOAD);

  return { totalSegments };
};

const nodeAdapter: HlsDownloaderNodeAdapter = createAdapter({
  name: 'NodeAdapter',
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  getPosterUrl,
  download,
  downloadToStream,
}) as HlsDownloaderNodeAdapter;

export const NodeAdapter: HlsDownloaderNodeAdapter = nodeAdapter;

export default NodeAdapter;
