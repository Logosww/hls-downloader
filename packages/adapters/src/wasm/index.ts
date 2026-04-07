import { Parser } from 'm3u8-parser';
import {
  createAdapter,
  HlsDownloaderEvent,
  selectBestVariant,
  type HlsDownloaderAdapterInternal,
  type HlsDownloaderFetchOption,
  type ParseHlsResult,
  type Playlist,
  type Segment,
} from '@hls-downloader/shared';
import { FFMessageLoadConfig, FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { fakeDelay, promiseWithLimit } from './utils';

/**
 * @internal
 */
declare global {
  const __FFmpeg_Base__: string;
  const __FFmpeg_Mt_Base__: string;
}

export type HlsDownloaderWasmAdapter = HlsDownloaderAdapterInternal<{
  coreURL?: string;
  wasmURL?: string;
  workerURL?: string;
  disableMultiThread?: boolean;
}>;

let ffmpeg: FFmpeg | null = null;
const parseResultCache: Record<string, ParseHlsResult> = Object.create(null);
const posterCache: Record<string, string | undefined> = Object.create(null);

const init: HlsDownloaderWasmAdapter['init'] = async function (
  this: HlsDownloaderWasmAdapter,
  option,
) {
  this.onEvent?.(HlsDownloaderEvent.FFMPEG_LOADING);
  ffmpeg = ffmpeg ?? new FFmpeg();
  if (!ffmpeg.loaded) {
    const multiThreadAvailable =
      typeof globalThis.crossOriginIsolated !== 'undefined' &&
      globalThis.crossOriginIsolated &&
      typeof SharedArrayBuffer !== 'undefined';
    const useMultiThread = !option?.disableMultiThread && multiThreadAvailable;
    const FFmpegBase = useMultiThread ? __FFmpeg_Mt_Base__ : __FFmpeg_Base__;
    const loadOption: FFMessageLoadConfig = {
      coreURL:
        option?.coreURL ?? (await toBlobURL(`${FFmpegBase}/ffmpeg-core.js`, 'text/javascript')),
      wasmURL:
        option?.wasmURL ?? (await toBlobURL(`${FFmpegBase}/ffmpeg-core.wasm`, 'application/wasm')),
      workerURL: useMultiThread
        ? (option?.workerURL ??
          (await toBlobURL(`${FFmpegBase}/ffmpeg-core.worker.js`, 'text/javascript')))
        : void 0,
    };
    await ffmpeg.load(loadOption);
    this.onEvent?.(HlsDownloaderEvent.FFMPEG_LOADED);
  }
};

const parseHls: HlsDownloaderWasmAdapter['parseHls'] = async function (
  this: HlsDownloaderWasmAdapter,
  { url: hlsUrl, headers },
) {
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
  adapter: HlsDownloaderWasmAdapter,
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

const captureRandomPoster = async function (
  this: HlsDownloaderWasmAdapter,
  segments: Segment[],
  headers?: Record<string, string>,
): Promise<string | undefined> {
  if (!ffmpeg?.loaded) {
    await init.call(this);
  }
  if (!ffmpeg) {
    throw new Error('FFmpeg is not initialized');
  }

  const index = Math.min(Math.floor(segments.length * 0.25), segments.length - 1);
  const inputFile = '__poster_input__.ts';
  const outputFile = '__poster_output__.jpg';
  let workerBusy = false;

  try {
    const response = await fetch(segments[index].uri, {
      headers,
      mode: 'cors',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;

    const buffer = await response.arrayBuffer();
    await ffmpeg.writeFile(inputFile, new Uint8Array(buffer));

    workerBusy = true;
    // -threads 1: avoids ffmpeg.reset() deadlock in multi-threaded WASM build
    // (Emscripten pthread cleanup hangs when swscaler spawns parallel slice threads)
    const exitCode = await ffmpeg.exec(
      [
        '-threads',
        '1',
        '-probesize',
        '32768',
        '-analyzeduration',
        '500000',
        '-i',
        inputFile,
        '-an',
        '-vframes',
        '1',
        '-update',
        '1',
        '-q:v',
        '2',
        outputFile,
      ],
      60_000,
      { signal: AbortSignal.timeout(60_000) },
    );
    workerBusy = false;

    if (exitCode !== 0) return undefined;

    const data = await ffmpeg.readFile(outputFile);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    if (bytes.length === 0) return undefined;

    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    if (workerBusy && ffmpeg) {
      ffmpeg.terminate();
      ffmpeg = null;
    }
    return undefined;
  } finally {
    if (ffmpeg?.loaded) {
      ffmpeg.deleteFile(inputFile).catch(() => {});
      ffmpeg.deleteFile(outputFile).catch(() => {});
    }
  }
};

const getPosterUrl: HlsDownloaderWasmAdapter['getPosterUrl'] = async function (
  this: HlsDownloaderWasmAdapter,
  option,
) {
  if (posterCache[option.url]) {
    return posterCache[option.url];
  }
  const { segments } = await resolveToSegments(this, option);
  return await captureRandomPoster.call(this, segments, option.headers);
};

const download: HlsDownloaderWasmAdapter['download'] = async function (
  this: HlsDownloaderWasmAdapter,
  {
    url,
    headers,
    filename = 'output.mp4',
    maxRetry = this.segmentRetryAttempts,
    downloadConcurrency = this.chunkDownloadConcurrency,
  },
) {
  this.onEvent?.(HlsDownloaderEvent.STARTING_DOWNLOAD);

  const { segments } = await resolveToSegments(this, { url, headers });
  const segmentWithIndex = segments.map((s, i) => ({
    ...s,
    index: i,
  }));
  this.onEvent?.(HlsDownloaderEvent.SOURCE_PARSED);
  await fakeDelay(1500);

  if (!ffmpeg?.loaded) {
    await init.call(this);
  }
  if (!ffmpeg) {
    throw new Error('FFmpeg is not initialized');
  }

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
    '-c:v',
    'copy',
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

const downloadAndWriteFile = async ({ url, fileIndex, headers }: DownloadFileOptions) => {
  if (!ffmpeg?.loaded) {
    throw new Error('FFmpeg is not initialized');
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: headers,
    mode: 'cors',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }

  const buffer = await response.arrayBuffer();
  const unit8Array = new Uint8Array(buffer);

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
    } catch (error) {
      retry++;
      if (retry >= maxRetry) {
        throw new Error(`Failed to download ${options.url} after ${maxRetry} attempts`);
      }
    }
  }
};

export const WasmAdapter = createAdapter({
  name: 'WasmAdapter',
  chunkDownloadConcurrency: 10,
  segmentRetryAttempts: 10,
  init,
  parseHls,
  getPosterUrl,
  download,
}) as HlsDownloaderWasmAdapter;

export default WasmAdapter;
