import { finiteEngine } from '../engine';
import { runMultiTrack, multiTrackCapabilities } from '../multitrack';
import {
  runRecording,
  recordingCapabilities,
  checkRecording,
  type RecordingBridgeFactory,
} from '../recording';
import { exportTimelineSubtitles } from '../timeline-subtitles';
import { timelineProfile, validateTimeline } from '../timeline';
import { parseMediaMetadata, decryptionProfile } from '../keyed';
import { resolveMedia } from '../renditions';
import { withOperation, exportSubtitles } from '../prepared';
import { query_capability_browser, BrowserRecording, parse_media_playlist_browser } from './wasm';
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
} from '@hls-downloader/shared';
import { transcodeMedia } from './mediabunny';
import { extractPosterFromSegmentUrl } from './poster';
import type {
  HlsDownloaderBrowserRequestOptions,
  HlsDownloaderBrowserOperationOptions,
} from '@hls-downloader/shared';
import { assertActive, cancellable } from './request';
import { ensureWasm, ensureRecordingWasm } from './wasm';

import { readResource, resolveWritablePlaylist } from './writable';

type DownloadResult = {
  blobURL: string;
  totalSegments: number;
  report?: import('@hls-downloader/shared').HlsEngineReport;
};

type BrowserAdditionalOptions = HlsDownloaderBrowserOperationOptions & {
  transcode?: HlsDownloaderBrowserTranscodeOptions;
};

export type HlsDownloaderBrowserAdapter = HlsDownloaderAdapterInternal<
  BrowserAdditionalOptions,
  DownloadResult,
  {},
  HlsDownloaderBrowserOperationOptions,
  Extract<
    import('@hls-downloader/shared').HlsRecordingOutput,
    { type: 'blob' | 'writable' | 'writables' }
  >
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
  const { url, headers, maxRetry, transcode, signal, browserRequest } = mergeDownloadOptions(
    this,
    globalOptions,
    options,
  );

  if (options.timeline) validateTimeline(options.timeline, false);
  if (transcode !== undefined && (options as { resume?: unknown }).resume)
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT,
      'Transcoding cannot use recovery',
    );
  emitAdapterEvent(this, options, HlsDownloaderEvent.STARTING_DOWNLOAD);

  if (signal?.aborted) {
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Download aborted', {
      adapter: this.name,
    });
  }

  if (!needsBrowserTranscode(transcode)) {
    const result = await finiteEngine(
      this,
      {
        ...options,
        url,
        headers,
        maxRetry,
        signal,
        browserRequest,
        transcode: undefined,
      },
      { type: 'blob', maxBytes: options.maxBytes ?? 256 * 1024 * 1024, format: 'mp4' },
      browserRecordingBridge,
    );
    emitAdapterEvent(this, options, HlsDownloaderEvent.READY_FOR_DOWNLOAD);
    return {
      blobURL: URL.createObjectURL(result.blob!),
      totalSegments: result.totalSegments,
      report: result.report,
    };
  }
  const browserTranscode = assertBrowserTranscodeOptions(transcode);
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const prepared = await finiteEngine(
    this,
    { ...options, url, headers, maxRetry, signal, browserRequest, transcode: undefined },
    { type: 'blob', maxBytes, format: 'fmp4' },
    browserRecordingBridge,
  );
  const result = await transcodeMedia({
    blob: prepared.blob!,
    transcode: browserTranscode,
    maxBytes,
    signal,
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
    totalSegments: prepared.totalSegments,
  };
};

const downloadToWritable: NonNullable<HlsDownloaderBrowserAdapter['downloadToWritable']> =
  async function (this: HlsDownloaderBrowserAdapter, options, write) {
    return finiteEngine(
      this,
      {
        ...options,
        ...mergeFetchOptions(getAdapterGlobalOptionsFromInternal(this, options), options),
      },
      { type: 'writable', writable: undefined as never },
      browserRecordingBridge,
      (bytes) => write(bytes),
    );
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
      transcode: merged.transcode,
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
        browserRecordingBridge,
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

const downloadToWritables: NonNullable<HlsDownloaderBrowserAdapter['downloadToWritables']> =
  async function (this: HlsDownloaderBrowserAdapter, options, write, control) {
    return finiteEngine(
      this,
      {
        ...options,
        ...mergeFetchOptions(getAdapterGlobalOptionsFromInternal(this, options), options),
      },
      {
        type: 'writables',
        acquire: async () => {
          throw new Error('internal output');
        },
      },
      browserRecordingBridge,
      write,
      control,
    );
  };
const downloadOutputs: NonNullable<HlsDownloaderBrowserAdapter['downloadOutputs']> =
  async function (this: HlsDownloaderBrowserAdapter, options) {
    const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new HlsDownloaderError(
        HlsDownloaderErrorCode.RESOURCE_LIMIT_EXCEEDED,
        'Invalid output capacity',
      );
    const chunks = new Map<string, Uint8Array[]>();
    let size = 0;
    const outputs: any[] = [];
    const result = await finiteEngine(
      this,
      options,
      {
        type: 'writables',
        acquire: async () => {
          throw new Error('internal output');
        },
      },
      browserRecordingBridge,
      async (bytes, index) => {
        size += bytes.byteLength;
        if (size > maxBytes)
          throw new HlsDownloaderError(
            HlsDownloaderErrorCode.RESOURCE_LIMIT_EXCEEDED,
            'Collected output capacity exceeded',
          );
        const list = chunks.get(index) ?? [];
        list.push(Uint8Array.from(bytes));
        chunks.set(index, list);
      },
      async (r) => {
        if (r.action === 'complete') {
          const blob = new Blob(
            (chunks.get(r.output.index) ?? []).map((b) => b.buffer as ArrayBuffer),
            { type: 'video/mp4' },
          );
          outputs.push({ index: r.output.index, blob });
          chunks.delete(r.output.index);
        }
        return '';
      },
    );
    return {
      ...result,
      outputs: outputs.map(({ index, blob }) => ({ index, blobURL: URL.createObjectURL(blob) })),
    };
  };

const downloadSubtitleOutputs: NonNullable<HlsDownloaderBrowserAdapter['downloadSubtitleOutputs']> =
  async function (this: HlsDownloaderBrowserAdapter, options) {
    const merged = mergeFetchOptions(
      getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options),
      options,
    );
    return withOperation({ ...options, ...merged }, (request) =>
      exportTimelineSubtitles(
        this,
        {
          ...request,
          subtitle: options.subtitle,
          timelineMap: options.timelineMap,
          track: options.track,
          filename: options.filename,
        },
        browserRecordingBridge,
      ),
    );
  };

const browserAdapter: HlsDownloaderBrowserAdapter = createAdapter({
  name: 'BrowserAdapter',
  async queryCapability(query) {
    await ensureWasm();
    return checkRecording(query_capability_browser(JSON.stringify(query)));
  },
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
    recording: recordingCapabilities(true),
    multiTrack: multiTrackCapabilities(true),
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
  async runMultiTrack(options, host, finite) {
    const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
    return runMultiTrack(
      this,
      { ...options, ...mergeFetchOptions(globalOptions, options) },
      host,
      browserRecordingBridge,
      finite,
    );
  },
  async runRecording(options, host) {
    const globalOptions = getAdapterGlobalOptionsFromInternal<BrowserGlobalOptions>(this, options);
    return runRecording(
      this,
      { ...options, ...mergeFetchOptions(globalOptions, options) },
      host,
      browserRecordingBridge,
    );
  },
  async parseMediaPlaylist(text: string, url: string) {
    await ensureWasm();
    return parseMediaMetadata(parse_media_playlist_browser(text, url));
  },
  getPosterUrl: scopedOperation(getPosterUrl),
  download: scopedOperation(download),
  downloadToStream: scopedOperation(downloadToStream),
  downloadToWritable,
  downloadSubtitles,
  downloadSubtitleOutputs,
  downloadOutputs,
  downloadToWritables,
  clearCache: () => {},
}) as HlsDownloaderBrowserAdapter;

export const BrowserAdapter: HlsDownloaderBrowserAdapter = browserAdapter;

export default BrowserAdapter;

const browserRecordingBridge: RecordingBridgeFactory = async (
  request,
  read,
  write,
  resolve,
  abort,
  control,
) => {
  await ensureRecordingWasm();
  if (typeof BrowserRecording !== 'function')
    throw new HlsDownloaderError(
      HlsDownloaderErrorCode.BRIDGE_VERSION_MISMATCH,
      'Incompatible recording bridge',
    );
  let bridge: BrowserRecording;
  try {
    bridge = new BrowserRecording(request, read, write, resolve, abort, control);
  } catch (e) {
    if (typeof e === 'string') checkRecording(e);
    throw e;
  }
  return {
    command: (value) => bridge.command(value),
    run: () => bridge.run(),
    dispose: () => bridge.free(),
  };
};
