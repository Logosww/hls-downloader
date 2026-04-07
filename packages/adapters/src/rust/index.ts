import {
  createAdapter,
  HlsDownloaderEvent,
  selectBestVariant,
  type DownloadResult,
  type HlsDownloaderAdapterInternal,
  type HlsDownloaderFetchOption,
  type ParseHlsResult,
  type Playlist,
  type Segment,
} from '@hls-downloader/shared';
import {
  initFfmpeg,
  parseHlsNative,
  downloadAndMerge,
  extractPoster,
  type NapiParseHlsResult,
} from './native.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type HlsDownloaderRustAdapter = HlsDownloaderAdapterInternal<{
  disableMultiThread?: boolean;
}>;

let initialized = false;
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

const init: HlsDownloaderRustAdapter['init'] = async function (
  this: HlsDownloaderRustAdapter,
  _option,
) {
  if (initialized) return;
  this.onEvent?.(HlsDownloaderEvent.FFMPEG_LOADING);
  initFfmpeg();
  initialized = true;
  this.onEvent?.(HlsDownloaderEvent.FFMPEG_LOADED);
};

const parseHls: HlsDownloaderRustAdapter['parseHls'] = async function (
  this: HlsDownloaderRustAdapter,
  { url, headers },
) {
  if (parseResultCache[url]) return parseResultCache[url];

  const napiResult = await parseHlsNative(url, headers);
  const result = toParseHlsResult(napiResult);
  parseResultCache[url] = result;
  return result;
};

async function resolveToSegments(
  adapter: HlsDownloaderRustAdapter,
  option: HlsDownloaderFetchOption,
): Promise<{ segments: Segment[]; resolvedUrl: string }> {
  const result = await parseHls.call(adapter, option);

  if (result.type === 'segment') {
    return { segments: result.data as Segment[], resolvedUrl: option.url };
  }

  if (result.type === 'playlist') {
    const best = selectBestVariant(result.data as Playlist[]);
    if (!best) throw new Error('Empty master playlist: no variant available');
    return resolveToSegments(adapter, { ...option, url: best.uri });
  }

  throw new Error(result.message ?? 'Failed to parse HLS');
}

const getPosterUrl: HlsDownloaderRustAdapter['getPosterUrl'] = async function (
  this: HlsDownloaderRustAdapter,
  option,
) {
  if (posterCache[option.url]) {
    return posterCache[option.url];
  }
  const { segments } = await resolveToSegments(this, option);
  const index = Math.min(Math.floor(segments.length * 0.25), segments.length - 1);
  const poster = await extractPoster(segments[index].uri, option.headers);
  return poster ?? undefined;
};

const download: HlsDownloaderRustAdapter['download'] = async function (
  this: HlsDownloaderRustAdapter,
  {
    url,
    headers,
    filename = 'output.mp4',
    maxRetry = this.segmentRetryAttempts,
    downloadConcurrency = this.chunkDownloadConcurrency,
  },
): Promise<DownloadResult> {
  this.onEvent?.(HlsDownloaderEvent.STARTING_DOWNLOAD);

  const { segments } = await resolveToSegments(this, { url, headers });
  this.onEvent?.(HlsDownloaderEvent.SOURCE_PARSED);

  const outputPath = join(tmpdir(), `hls-dl-${Date.now()}-${filename}`);
  const napiSegments = segments.map((s) => ({ uri: s.uri, duration: s.duration ?? 0 }));

  const self = this;
  const filePath = await downloadAndMerge(
    napiSegments,
    outputPath,
    headers,
    downloadConcurrency,
    maxRetry,
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
    blobURL: filePath,
    totalSegments: segments.length,
  };
};

export const RustAdapter = createAdapter({
  name: 'RustAdapter',
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  getPosterUrl,
  download,
}) as HlsDownloaderRustAdapter;

export default RustAdapter;
