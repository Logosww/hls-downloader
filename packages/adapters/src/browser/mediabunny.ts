import {
  BufferSource,
  BufferTarget,
  Conversion,
  CustomPathedSource,
  HLS_FORMATS,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
} from 'mediabunny';
import type { HlsDownloaderBrowserTranscodeOptions } from '@hls-downloader/shared';

export type TranscodeHlsOptions = {
  url: string;
  transcode: HlsDownloaderBrowserTranscodeOptions;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onSegmentLoaded?: (loaded: number) => void;
  onProgress?: (progress: number) => void;
  segmentUrls?: string[];
};

export type TranscodeHlsResult = {
  buffer: ArrayBuffer;
  mimeType: 'video/mp4' | 'video/webm';
};

const TRANSCODE_PRESETS = {
  h264: { videoCodec: 'avc', audioCodec: 'aac', container: 'mp4' },
  hevc: { videoCodec: 'hevc', audioCodec: 'aac', container: 'mp4' },
  vp9: { videoCodec: 'vp9', audioCodec: 'opus', container: 'webm' },
} as const;

function parseBitrate(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('Bitrate must be positive');
    return value;
  }

  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*([kmg])?(?:bps)?$/);
  if (!match) throw new TypeError(`Invalid bitrate: ${value}`);
  const multiplier =
    match[2] === 'g' ? 1_000_000_000 : match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  return Number(match[1]) * multiplier;
}

function createHlsSource(
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  segmentUrls: string[],
  onSegmentLoaded: ((loaded: number) => void) | undefined,
) {
  const normalizedSegments = new Set(segmentUrls.map((segmentUrl) => resolveUrl(segmentUrl, url)));
  const loadedSegments = new Set<string>();
  const sourceCache = new Map<string, Promise<ArrayBuffer>>();

  return new CustomPathedSource(url, async ({ path }) => {
    const resolvedUrl = resolveUrl(String(path), url);
    const bufferPromise = sourceCache.get(resolvedUrl) ?? fetchBuffer(resolvedUrl, headers, signal);
    sourceCache.set(resolvedUrl, bufferPromise);
    const buffer = await bufferPromise;

    if (normalizedSegments.has(resolvedUrl) && !loadedSegments.has(resolvedUrl)) {
      loadedSegments.add(resolvedUrl);
      onSegmentLoaded?.(loadedSegments.size);
    }

    return new BufferSource(buffer);
  });
}

export async function transcodeHls({
  url,
  transcode,
  headers,
  signal,
  onSegmentLoaded,
  onProgress,
  segmentUrls = [],
}: TranscodeHlsOptions): Promise<TranscodeHlsResult> {
  const preset = TRANSCODE_PRESETS[transcode.preset];
  const source = createHlsSource(url, headers, signal, segmentUrls, onSegmentLoaded);
  const input = new Input({ source, formats: HLS_FORMATS });
  const target = new BufferTarget();
  const output = new Output({
    format:
      preset.container === 'webm'
        ? new WebMOutputFormat()
        : new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      showWarnings: false,
      video: {
        codec: preset.videoCodec,
        bitrate: parseBitrate(transcode.videoBitrate) ?? QUALITY_HIGH,
        forceTranscode: true,
        hardwareAcceleration: 'no-preference',
      },
      audio: {
        codec: preset.audioCodec,
        bitrate: parseBitrate(transcode.audioBitrate) ?? QUALITY_HIGH,
        forceTranscode: true,
      },
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((track) => track.reason).join(', ');
      throw new TypeError(
        `Browser cannot transcode preset "${transcode.preset}"${reasons ? `: ${reasons}` : ''}`,
      );
    }

    conversion.onProgress = onProgress;
    const onAbort = () => void conversion.cancel();
    if (signal?.aborted) {
      const error = new Error('Download aborted');
      error.name = 'AbortError';
      throw error;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await conversion.execute();
    } catch (error) {
      if (signal?.aborted) {
        const abortError = new Error('Download aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (!target.buffer) throw new Error('Mediabunny did not produce a transcoded buffer');

    return {
      buffer: target.buffer,
      mimeType: preset.container === 'webm' ? 'video/webm' : 'video/mp4',
    };
  } finally {
    input.dispose();
  }
}

async function fetchBuffer(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return await response.arrayBuffer();
}

function resolveUrl(path: string, baseUrl: string): string {
  try {
    return new URL(path, baseUrl).href;
  } catch {
    return path;
  }
}
