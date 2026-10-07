import { runMultiTrack, multiTrackCapabilities } from '../multitrack';
import {
  runRecording,
  recordingCapabilities,
  checkRecording,
  type RecordingBridgeFactory,
} from '../recording';
import { exportTimelineSubtitles } from '../timeline-subtitles';
import { timelineProfile, validateTimeline } from '../timeline';
import { executeKeyed } from '../keyed';
import {
  executeMedia,
  requiresKeyed,
  parseMediaMetadata,
  decryptionProfile,
  type KeyedEngine,
} from '../keyed';
import { resolveMedia, selectAudio } from '../renditions';
import { withOperation, exportSubtitles, type Engine } from '../prepared';
import { assertActive } from '../browser/request';
import {
  createAdapter,
  emitAdapterEvent,
  getAdapterGlobalOptionsFromInternal,
  HlsDownloaderEvent,
  selectBestVariant,
  stripContext,
  ParseHlsCache,
  buildParseHlsCacheKey,
  type HlsDownloaderAdapterInternal,
  type HlsDownloaderDownloadOptions,
  type HlsDownloaderFetchOptions,
  type HlsDownloaderGlobalDownloadOptions,
  type HlsDownloaderTranscodeOptions,
  needsFfmpegTranscode,
  buildFfmpegOutputArgs,
  getDownloadOutputFilename,
  HlsDownloaderError,
  HlsDownloaderErrorCode,
  type ParseHlsResult,
  type Playlist,
  type Rendition,
  type Segment,
  type VariantSelectOptions,
  assertSupportedSegments,
} from '@hls-downloader/shared';
import {
  openResumeTask,
  closeResumeTask,
  runResumeTask,
  initFfmpeg,
  preparedNative,
  keyedNative,
  timelineNative,
  continuousCreate,
  continuousCommand,
  continuousRun,
  parseMediaPlaylistNative,
  parseHlsNative,
  downloadAndMerge,
  extractPoster,
  transmuxHlsNative,
  createCancelToken,
  cancelJob,
  type NapiParseHlsResult,
  type NapiAria2Config,
} from './native.js';
import { extractPosterFromSegmentUrl } from './poster';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type NodeAdapterResumeOptions = { directory: string };
type DownloadOnlyOptions = { resume?: NodeAdapterResumeOptions };

export type NodeAdapterAria2Options = NapiAria2Config;
type AdditionalOptions = {
  aria2?: NodeAdapterAria2Options;
};
type DownloadResult = {
  filePath: string;
  totalSegments: number;
  timelineReport?: import('@hls-downloader/shared').HlsTimelineReport;
};
export type HlsDownloaderNodeAdapter = HlsDownloaderAdapterInternal<
  AdditionalOptions,
  DownloadResult,
  DownloadOnlyOptions,
  {},
  Exclude<import('@hls-downloader/shared').HlsRecordingOutput, { type: 'blob' }>
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
const parseResultCache = new ParseHlsCache();
const posterCache: Record<string, string | undefined> = Object.create(null);

function toParseHlsResult(napi: NapiParseHlsResult): ParseHlsResult {
  switch (napi.resultType) {
    case 'playlist':
      return {
        type: 'playlist',
        renditions: (JSON.parse(napi.playlists?.[0]?.renditionsJson ?? '[]') as Rendition[]).map(
          (r) => ({ ...r, uri: r.uri ?? undefined, language: r.language ?? undefined }),
        ),
        data: (napi.playlists ?? []).map((p) => ({
          name: p.name,
          bandwidth: p.bandwidth,
          uri: p.uri,
          resolution: p.resolution
            ? { width: p.resolution.width, height: p.resolution.height }
            : undefined,
          codecs: p.codecs,
          frameRate: p.frameRate,
          isAudioOnly: p.isAudioOnly,
          hasAlternateRenditions: p.hasAlternateRenditions,
          audioGroup: p.audioGroup,
          subtitlesGroup: p.subtitlesGroup,
          videoGroup: p.videoGroup,
        })),
      };
    case 'segment':
      return {
        type: 'segment',
        data: (napi.segments ?? []).map((s) => ({
          uri: s.uri,
          duration: s.duration,
          key: s.encryptionMethod ? { method: s.encryptionMethod } : undefined,
          discontinuity: s.discontinuity,
          isLive: s.isLive,
        })),
      };
    default:
      const message = napi.message ?? 'Unknown error';
      return {
        type: 'error',
        message,
        error: new HlsDownloaderError(HlsDownloaderErrorCode.MANIFEST_INVALID, message, {
          adapter: 'NodeAdapter',
        }),
      };
  }
}

const init: HlsDownloaderNodeAdapter['init'] = async function (
  this: HlsDownloaderNodeAdapter,
  options,
) {
  if (
    (
      getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options ?? {}) as Record<
        string,
        unknown
      > | null
    )?.resume !== undefined
  ) {
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
      'Recovery is a per-download option',
    );
  }
  // FFmpeg is loaded only by APIs that need it.
};

function ensureFfmpegLoaded(adapter: HlsDownloaderNodeAdapter, options: Record<string, unknown>) {
  if (ffmpegInitialized) return;
  emitAdapterEvent(adapter, options, HlsDownloaderEvent.FFMPEG_LOADING);
  initFfmpeg();
  ffmpegInitialized = true;
  emitAdapterEvent(adapter, options, HlsDownloaderEvent.FFMPEG_LOADED);
}

const parseHls: HlsDownloaderNodeAdapter['parseHls'] = async function (
  this: HlsDownloaderNodeAdapter,
  options,
) {
  const { url, headers } = mergeFetchOptions(
    getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options),
    options,
  );

  const cacheKey = buildParseHlsCacheKey(url, headers);
  const cached = (options as Record<string, unknown>).resume
    ? undefined
    : parseResultCache.get(cacheKey);
  if (cached) return cached;

  const napiResult = await parseHlsNative(
    url,
    headers,
    (options as Record<string, unknown>).__resumeJobId as string | undefined,
  );
  const result = toParseHlsResult(napiResult);
  // set 内部会跳过 error，不再缓存失败结果
  if (!(options as Record<string, unknown>).resume) parseResultCache.set(cacheKey, result);
  return result;
};

async function resolveToSegments(
  adapter: HlsDownloaderNodeAdapter,
  options: Record<string, unknown>,
  state: { visited: Set<string>; depth: number } = { visited: new Set(), depth: 0 },
): Promise<{ segments: Segment[]; resolvedUrl: string }> {
  const { url } = mergeFetchOptions(
    getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(adapter, options),
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
      getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(adapter, options),
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
    if (best.videoGroup)
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.UNSUPPORTED_RENDITION,
        'Alternate video groups are unsupported',
      );
    if (best.audioGroup && selectAudio(result.renditions ?? [], best.audioGroup)?.uri) {
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
        'External audio is incompatible with recovery, transcoding or aria2',
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
  ensureFfmpegLoaded(this, options);
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

  if (options.timeline) {
    validateTimeline(options.timeline, false);
    if (transcode !== undefined || options.resume !== undefined || aria2?.enabled)
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
        'Timeline output cannot use transcoding, recovery or aria2',
      );
  }
  emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);

  if (signal?.aborted) {
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
      adapter: this.name,
    });
  }

  if (options.decryption && (options.resume || transcode !== undefined || aria2?.enabled))
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
      'Decryption is incompatible with recovery, transcoding or aria2',
    );
  if (options.audio && (options.resume || transcode !== undefined || aria2?.enabled))
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
      'Audio selection is incompatible with recovery, transcoding or aria2',
    );
  if (options.resume === undefined && !needsFfmpegTranscode(transcode) && !aria2?.enabled) {
    return withOperation(
      { ...options, url, headers, filename, maxRetry, downloadConcurrency, signal, transcode },
      async (request) => {
        const media = await resolveMedia(request, transcode !== undefined, true);
        emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
        const workDir = join(process.cwd(), randomUUID());
        await mkdir(workDir, { recursive: true });
        try {
          const output = join(workDir, 'output.mp4');
          const report = await executeMedia(
            this,
            request,
            media,
            nodeEngine,
            nodeKeyedEngine,
            'file',
            async () => {},
            output,
            nodeTimelineEngine,
          );
          const filePath = resolve(filename);
          assertActive(request.signal);
          try {
            await rename(output, filePath);
          } catch (cause) {
            throw new HlsDownloaderError(
              HlsDownloaderErrorCode.OUTPUT_WRITE_FAILED,
              'Failed to publish output file',
              { cause },
            );
          }
          emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
          return {
            filePath,
            totalSegments: report.totalSegments,
            timelineReport: report.timelineReport,
          };
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      },
      this.name,
    );
  }
  if (options.resume !== undefined) {
    return downloadResumable(this, options, {
      url,
      headers,
      filename,
      maxRetry,
      downloadConcurrency,
      aria2,
      transcode,
      signal,
    });
  }

  const { segments, resolvedUrl } = await resolveToSegments(this, { ...options, url, headers });
  emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);

  const workDir = join(process.cwd(), randomUUID());
  await mkdir(workDir, { recursive: true });
  const napiSegments = segments.map((s) => ({
    uri: s.uri,
    duration: s.duration ?? 0,
    encryptionMethod: typeof s.key?.method === 'string' ? s.key.method : undefined,
    discontinuity: s.discontinuity === true,
    isLive: s.isLive === true,
  }));

  const transcodeArgs = needsFfmpegTranscode(transcode) ? buildFfmpegOutputArgs(transcode) : null;
  const shouldUseFfmpeg = !!transcodeArgs || aria2?.enabled;

  try {
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
            emitAdapterEvent(this, options, HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
              total,
              completed,
            });
          },
          onMuxProgress: (completed, total) => {
            emitAdapterEvent(this, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
              total,
              completed,
            });
          },
        });

        emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);

        return {
          filePath,
          totalSegments: segments.length,
        };
      } finally {
        cleanup();
      }
    }

    ensureFfmpegLoaded(this, options);
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
          emitAdapterEvent(self, options, HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
            total,
            completed,
          });
        } else if (phase === 'merging') {
          emitAdapterEvent(self, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
            total,
            completed,
          });
        }
      },
    );

    emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);

    return {
      filePath: filePath,
      totalSegments: segments.length,
    };
  } catch (e) {
    // Rust 侧成功/失败都已清理 workDir；此处仅保护 Rust 未被调用就失败的边界（如 ensureFfmpegLoaded）
    await rm(workDir, { recursive: true, force: true });
    throw e;
  }
};

function resumeError(cause: unknown): HlsDownloaderError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = Object.values(HlsDownloaderErrorCode).find((code) => message.startsWith(`${code}:`));
  return new HlsDownloaderError(
    code ?? HlsDownloaderErrorCode.TRANSMUX_FAILED,
    code ? message : 'Resumable download failed',
    { adapter: 'NodeAdapter', cause },
  );
}

async function downloadResumable(
  adapter: HlsDownloaderNodeAdapter,
  options: Parameters<HlsDownloaderNodeAdapter['download']>[0],
  merged: ReturnType<typeof mergeDownloadOptions>,
): Promise<DownloadResult> {
  const { url, headers, filename, maxRetry, downloadConcurrency, aria2, transcode, signal } =
    merged;
  if (transcode !== undefined || aria2?.enabled) {
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
      'Recovery supports plain Node downloads only',
      { adapter: adapter.name },
    );
  }
  if (
    !options.resume ||
    typeof options.resume.directory !== 'string' ||
    !options.resume.directory.trim()
  ) {
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.RESUME_INVALID,
      'A recovery directory is required',
    );
  }
  if (!filename || filename === '.' || filename.includes('..') || /[/\\]/.test(filename)) {
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.RESUME_INVALID,
      'Output filename must be a basename',
    );
  }
  const normalizedHeaders = Object.entries(headers ?? {})
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([a], [b]) => a!.localeCompare(b!));
  const identity = JSON.stringify({
    url,
    headers: normalizedHeaders,
    variant: options.variant
      ? Object.fromEntries(Object.entries(options.variant).sort(([a], [b]) => a.localeCompare(b)))
      : null,
  });
  let session: Awaited<ReturnType<typeof openResumeTask>> | undefined;
  // A token is required even without a user signal: storage failures cancel native work.
  const directory = resolve(options.resume.directory);
  const output = resolve(filename);
  const { jobId, cleanup } = await setupCancelToken(signal ?? new AbortController().signal);
  let active = true;
  try {
    session = await openResumeTask(directory, identity, output);
    if (signal?.aborted)
      throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted');
    let resolvedUrl = '';
    if (session.needsInput) {
      ({ resolvedUrl } = await resolveToSegments(adapter, {
        ...options,
        url,
        headers,
        __resumeJobId: jobId,
      }));
    }
    emitAdapterEvent(adapter, options, HlsDownloaderEvent.SOURCE_PARSED);
    const result = await runResumeTask(
      session.id,
      resolvedUrl,
      headers ?? null,
      downloadConcurrency,
      maxRetry,
      jobId!,
      (err: Error | null, progress: [string, number, number]) => {
        if (err || !active) return;
        const [phase, completed, total] = progress;
        emitAdapterEvent(
          adapter,
          options,
          phase === 'merging'
            ? HlsDownloaderEvent.STITCHING_SEGMENTS
            : HlsDownloaderEvent.DOWNLOADING_SEGMENTS,
          { completed, total },
        );
      },
    );
    active = false;
    emitAdapterEvent(adapter, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
      completed: result.totalSegments,
      total: result.totalSegments,
    });
    emitAdapterEvent(adapter, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
    return result;
  } catch (cause) {
    if (cause instanceof HlsDownloaderError) throw cause;
    throw resumeError(cause);
  } finally {
    active = false;
    if (session) closeResumeTask(session.id);
    cleanup();
  }
}

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
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
      adapter: 'NodeAdapter',
    });
  }

  const jobId = await createCancelToken();
  const onAbort = () => {
    try {
      cancelJob(jobId);
    } catch {}
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  return {
    jobId,
    cleanup: () => {
      signal.removeEventListener('abort', onAbort);
      try {
        cancelJob(jobId);
      } catch {}
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

const nodeEngine: Engine = async (request, read, write, progress, signal) => {
  const { jobId, cleanup } = await setupCancelToken(signal);
  let active = true;
  try {
    return await preparedNative(
      request,
      jobId!,
      async (err: Error | null, resource: string) => {
        if (err) throw err;
        return Buffer.from(await read(resource));
      },
      async (err: Error | null, bytes: Buffer) => {
        if (err) throw err;
        await write(new Uint8Array(bytes));
      },
      (err: Error | null, event: string) => {
        if (!err && active) progress(event);
      },
    );
  } finally {
    active = false;
    cleanup();
  }
};
const downloadToWritable: NonNullable<HlsDownloaderNodeAdapter['downloadToWritable']> =
  async function (this: HlsDownloaderNodeAdapter, options, write) {
    if (options.timeline) validateTimeline(options.timeline, false);
    const globalOptions = getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options);
    const merged = { ...mergeDownloadOptions(this, globalOptions, options), transcode: undefined };
    return withOperation(
      { ...options, ...merged },
      async (request) => {
        emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
        const media = await resolveMedia(
          request,
          Boolean((options as Record<string, unknown>).__rejectAudio),
          true,
        );
        if ((media.audio || requiresKeyed(media, request)) && merged.aria2?.enabled)
          throw new HlsDownloaderError(
            HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
            'Audio selection cannot use aria2',
          );
        emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
        if (requiresKeyed(media, request) && (options as Record<string, unknown>).__rejectAudio)
          throw new HlsDownloaderError(
            HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
            'Encrypted input cannot be transcoded',
          );
        const report = await executeMedia(
          this,
          request,
          media,
          nodeEngine,
          nodeKeyedEngine,
          'stream',
          write,
          undefined,
          nodeTimelineEngine,
        );
        emitAdapterEvent(this, options, HlsDownloaderEvent.STITCHING_SEGMENTS, {
          completed: report.totalSegments,
          total: report.totalSegments,
        });
        return { totalSegments: report.totalSegments, timelineReport: report.timelineReport };
      },
      this.name,
    );
  };
const downloadToStream: HlsDownloaderNodeAdapter['downloadToStream'] = async function (
  this: HlsDownloaderNodeAdapter,
  options,
  onChunk,
) {
  const merged = mergeDownloadOptions(
    this,
    getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options),
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
    } as Parameters<NonNullable<HlsDownloaderNodeAdapter['downloadToWritable']>>[0],
    async (bytes) => {
      onChunk(bytes);
    },
  );
  emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
  return result;
};
const downloadSubtitles: NonNullable<HlsDownloaderNodeAdapter['downloadSubtitles']> =
  async function (this: HlsDownloaderNodeAdapter, options) {
    const merged = mergeDownloadOptions(
      this,
      getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options),
      options,
    );
    return withOperation(
      { ...options, ...merged },
      async (request) => {
        emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
        const media = await resolveMedia(request);
        emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
        return exportSubtitles(
          this,
          { ...request, subtitle: options.subtitle, filename: options.filename },
          media,
          nodeEngine,
        );
      },
      this.name,
    );
  };

const downloadToWritables: NonNullable<HlsDownloaderNodeAdapter['downloadToWritables']> =
  async function (this: HlsDownloaderNodeAdapter, options, write, control) {
    const globalOptions = getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options);
    const merged = { ...mergeDownloadOptions(this, globalOptions, options), transcode: undefined };
    if (
      options.transcode !== undefined ||
      (options as Record<string, unknown>).resume !== undefined ||
      merged.aria2?.enabled
    )
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
        'Timeline output cannot use transcoding, recovery or aria2',
      );
    const timeline = options.timeline ?? {};
    validateTimeline(timeline, true);
    return withOperation(
      { ...options, ...merged, timeline },
      async (request) => {
        emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
        const media = await resolveMedia(request, false, true);
        emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
        const report = await executeKeyed(
          this,
          request,
          media,
          nodeTimelineEngine,
          'stream-outputs',
          (bytes, index) => write(bytes, index!),
          undefined,
          control,
        );
        return { totalSegments: report.totalSegments, timelineReport: report.timelineReport! };
      },
      this.name,
    );
  };
const downloadOutputs: NonNullable<HlsDownloaderNodeAdapter['downloadOutputs']> = async function (
  this: HlsDownloaderNodeAdapter,
  options,
) {
  const merged = mergeDownloadOptions(
    this,
    getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options),
    options,
  );
  if (
    merged.transcode !== undefined ||
    merged.aria2?.enabled ||
    (options as Record<string, unknown>).resume !== undefined
  )
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
      'Timeline output cannot use transcoding, recovery or aria2',
    );
  const timeline = options.timeline ?? {};
  validateTimeline(timeline, true);
  return withOperation(
    { ...options, ...merged, timeline },
    async (request) => {
      emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);
      const media = await resolveMedia(request, false, true);
      emitAdapterEvent(this, options, HlsDownloaderEvent.SOURCE_PARSED);
      const paths = new Map<string, string>();
      const completed: import('@hls-downloader/shared').HlsCompletedOutput[] = [];
      try {
        const report = await executeKeyed(
          this,
          request,
          media,
          nodeTimelineEngine,
          'file-outputs',
          async () => {},
          undefined,
          async (r) => {
            if (r.action === 'acquire') {
              const path = resolve(
                merged.filename.replace(/\.mp4$/i, '') +
                  '.' +
                  (BigInt(r.output.index) + 1n).toString().padStart(3, '0') +
                  '.mp4',
              );
              paths.set(r.output.index, path);
              return path;
            }
            completed.push({ ...r.output, filePath: paths.get(r.output.index)! });
            return '';
          },
        );
        const outputs = completed.map((o) => ({
          index: o.index,
          filePath: o.filePath!,
        }));
        emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
        return {
          outputs,
          totalSegments: report.totalSegments,
          timelineReport: report.timelineReport!,
        };
      } catch (error) {
        if (error instanceof HlsDownloaderError)
          throw new HlsDownloaderError(error.code, error.message, {
            ...error,
            cause: error.cause,
            completedOutputs: completed,
          });
        throw error;
      }
    },
    this.name,
  );
};

const downloadSubtitleOutputs: NonNullable<HlsDownloaderNodeAdapter['downloadSubtitleOutputs']> =
  async function (this: HlsDownloaderNodeAdapter, options) {
    const merged = mergeFetchOptions(
      getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options),
      options,
    );
    return withOperation(
      { ...options, ...merged },
      (request) =>
        exportTimelineSubtitles(this, {
          ...request,
          subtitle: options.subtitle,
          timelineReport: options.timelineReport,
          track: options.track,
          filename: options.filename,
        }),
      this.name,
    );
  };

const nodeAdapter: HlsDownloaderNodeAdapter = createAdapter({
  name: 'NodeAdapter',
  capabilities: {
    download: true,
    stream: true,
    transcodePresets: ['h264', 'hevc', 'vp9'],
    configurableRetry: true,
    byteRange: true,
    aes128: true,
    decryption: decryptionProfile,
    timeline: timelineProfile,
    liveRecording: true,
    recording: recordingCapabilities(false),
    multiTrack: multiTrackCapabilities(false),
    persistentOutput: true,
    writableOutput: true,
    alternateAudio: true,
    subtitleExport: true,
    resumableDownload: true,
  },
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  async runMultiTrack(options, host, finite) {
    const globalOptions = getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options);
    return runMultiTrack(
      this,
      { ...options, ...mergeFetchOptions(globalOptions, options) },
      host,
      nodeRecordingBridge,
      finite,
    );
  },
  async runRecording(options, host) {
    const globalOptions = getAdapterGlobalOptionsFromInternal<NodeGlobalOptions>(this, options);
    return runRecording(
      this,
      { ...options, ...mergeFetchOptions(globalOptions, options) },
      host,
      nodeRecordingBridge,
    );
  },
  async parseMediaPlaylist(text: string, url: string) {
    return parseMediaMetadata(parseMediaPlaylistNative(text, url));
  },
  getPosterUrl,
  download,
  downloadToStream,
  downloadToWritable,
  downloadSubtitles,
  downloadSubtitleOutputs,
  downloadOutputs,
  downloadToWritables,
  clearCache: () => parseResultCache.clear(),
}) as HlsDownloaderNodeAdapter;

export const NodeAdapter: HlsDownloaderNodeAdapter = nodeAdapter;

export default NodeAdapter;

const nodeKeyedEngine: KeyedEngine = async (
  request,
  read,
  write,
  resolve,
  abort,
  progress,
  signal,
) => {
  if (typeof timelineNative !== 'function')
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.BRIDGE_VERSION_MISMATCH,
      'Incompatible native bridge',
    );
  const { jobId, cleanup } = await setupCancelToken(signal);
  let active = true;
  try {
    return await keyedNative(
      request,
      jobId!,
      async (err: Error | null, value: string) => {
        if (err) throw err;
        return Buffer.from(await read(value));
      },
      async (err: Error | null, bytes: Buffer) => {
        if (err) throw err;
        await write(new Uint8Array(bytes));
      },
      async (err: Error | null, value: string) => {
        if (err) throw err;
        const reply = await resolve(value);
        return { ...reply, key: Buffer.from(reply.key) };
      },
      (err: Error | null, id: string) => {
        if (!err && active) abort(id);
      },
      (err: Error | null, event: string) => {
        if (!err && active) progress(event);
      },
    );
  } finally {
    active = false;
    cleanup();
  }
};

const nodeTimelineEngine: KeyedEngine = async (
  request,
  read,
  write,
  resolve,
  abort,
  _progress,
  signal,
  control,
) => {
  if (typeof timelineNative !== 'function')
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.BRIDGE_VERSION_MISMATCH,
      'Incompatible native bridge',
    );
  const { jobId, cleanup } = await setupCancelToken(signal);
  let active = true;
  try {
    return await timelineNative(
      request,
      jobId!,
      async (err: Error | null, value: string) => {
        if (err) throw err;
        return Buffer.from(await read(value));
      },
      async (err: Error | null, value: [Buffer, string]) => {
        if (err) throw err;
        await write(new Uint8Array(value[0]), value[1]);
      },
      async (err: Error | null, value: string) => {
        if (err) throw err;
        const r = await resolve(value);
        return { ...r, key: Buffer.from(r.key) };
      },
      (err: Error | null, id: string) => {
        if (!err && active) abort(id);
      },
      async (err: Error | null, value: string) => {
        if (err) throw err;
        return control ? control(JSON.parse(value)) : '';
      },
    );
  } finally {
    active = false;
    cleanup();
  }
};

const nodeRecordingBridge: RecordingBridgeFactory = async (
  request,
  read,
  write,
  resolve,
  abort,
  control,
) => {
  if ([continuousCreate, continuousCommand, continuousRun].some((fn) => typeof fn !== 'function'))
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.BRIDGE_VERSION_MISMATCH,
      'Incompatible recording bridge',
    );
  const { id } = checkRecording(
    continuousCreate(
      request,
      async (err: Error | null, value: string) => {
        if (err) throw err;
        return Buffer.from(await read(value));
      },
      async (err: Error | null, value: [Buffer, string]) => {
        if (err) throw err;
        await write(new Uint8Array(value[0]), value[1]);
      },
      async (err: Error | null, value: string) => {
        if (err) throw err;
        const reply = await resolve(value);
        return { ...reply, key: Buffer.from(reply.key) };
      },
      (err: Error | null, value: string) => {
        if (!err) abort(value);
      },
      async (err: Error | null, value: string) => {
        if (err) throw err;
        return control(value);
      },
    ),
  );
  return {
    command: (value) => continuousCommand(id, value),
    run: () => continuousRun(id),
    dispose() {},
  };
};
