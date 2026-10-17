import {
  BlobSource,
  StreamTarget,
  Conversion,
  MP4,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
} from 'mediabunny';
import { HlsDownloaderError, HlsDownloaderErrorCode as Code } from '@hls-downloader/shared';
import type { HlsDownloaderBrowserTranscodeOptions } from '@hls-downloader/shared';
import { assertActive } from './request';

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

/** Transcode only clear, selected and timeline-normalized Engine output. */
export async function transcodeMedia({
  blob,
  transcode,
  maxBytes,
  signal,
  onProgress,
}: {
  blob: Blob;
  transcode: HlsDownloaderBrowserTranscodeOptions;
  maxBytes: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<{ buffer: ArrayBuffer; mimeType: 'video/mp4' | 'video/webm' }> {
  assertActive(signal);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Invalid transcode capacity');
  const preset = TRANSCODE_PRESETS[transcode.preset];
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  // A seekable bounded target also supports WebM header updates. Check before allocating.
  let bytes = new Uint8Array(0),
    length = 0;
  let outputFailure: HlsDownloaderError | undefined;
  let conversion: Conversion | undefined;
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation ??= conversion?.cancel().catch(() => {});
  };
  const target = new StreamTarget(
    new WritableStream({
      write({ data, position }) {
        if (signal?.aborted || outputFailure) return;
        const end = position + data.byteLength;
        if (!Number.isSafeInteger(end) || position < 0 || end > maxBytes) {
          outputFailure = new HlsDownloaderError(
            Code.RESOURCE_LIMIT_EXCEEDED,
            'Transcoded output exceeds maxBytes',
          );
          // Keep the borrowed target closable while Conversion tears down its encoders.
          queueMicrotask(abort);
          return;
        }
        if (end > bytes.length) {
          const next = new Uint8Array(Math.min(maxBytes, Math.max(end, bytes.length * 2, 65536)));
          next.set(bytes);
          bytes = next;
        }
        bytes.set(data, position);
        length = Math.max(length, end);
      },
    }),
  );
  const output = new Output({
    format:
      preset.container === 'webm'
        ? new WebMOutputFormat()
        : new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target,
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    conversion = await Conversion.init({
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
    assertActive(signal);
    if (!conversion.isValid || conversion.discardedTracks.length)
      throw new HlsDownloaderError(
        Code.UNSUPPORTED_OUTPUT,
        `Browser cannot transcode every selected track with preset "${transcode.preset}"`,
        { reason: 'UnsupportedEncoder' },
      );
    conversion.onProgress = onProgress;
    await conversion.execute();
    await cancellation;
    assertActive(signal);
    if (outputFailure) throw outputFailure;
    return {
      buffer: bytes.slice(0, length).buffer,
      mimeType: preset.container === 'webm' ? 'video/webm' : 'video/mp4',
    };
  } catch (cause) {
    abort();
    await cancellation;
    assertActive(signal);
    if (outputFailure) throw outputFailure;
    if (cause instanceof HlsDownloaderError) throw cause;
    throw new HlsDownloaderError(Code.TRANSCODE_FAILED, 'Browser transcoding failed', { cause });
  } finally {
    signal?.removeEventListener('abort', abort);
    input.dispose();
  }
}
