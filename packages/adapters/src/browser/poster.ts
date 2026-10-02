import { readResource } from './writable';
import { assertActive } from './request';
import {
  HlsDownloaderError,
  HlsDownloaderErrorCode,
  type Segment,
  type HlsDownloaderBrowserRequestOptions,
} from '@hls-downloader/shared';
import { ALL_FORMATS, BufferSource, CanvasSink, EncodedPacketSink, Input } from 'mediabunny';

export type ExtractPosterFromSegmentOptions = {
  segment: Segment;
  maxRetry: number;
  browserRequest?: HlsDownloaderBrowserRequestOptions;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export async function extractPosterFromSegmentUrl({
  segment,
  maxRetry,
  browserRequest,
  headers,
  signal,
}: ExtractPosterFromSegmentOptions): Promise<string | undefined> {
  const activeSignal = signal ?? new AbortController().signal;
  const read = async (resource: { uri: string; byterange?: { offset: number; length: number } }) =>
    (
      await readResource(
        { url: resource.uri, range: resource.byterange },
        headers,
        maxRetry,
        activeSignal,
        HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
        browserRequest,
      )
    ).bytes;
  const init = segment.map ? await read(segment.map) : new Uint8Array();
  const media = await read(segment);
  const segmentBuffer = new Uint8Array(init.length + media.length);
  segmentBuffer.set(init);
  segmentBuffer.set(media, init.length);
  assertActive(signal);

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(segmentBuffer),
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return undefined;

    const decodable = await videoTrack.canDecode();
    if (!decodable) return undefined;

    const timestamp = await resolvePosterTimestamp(videoTrack);
    const sink = new CanvasSink(videoTrack);
    const result = await sink.getCanvas(timestamp);
    if (!result?.canvas) return undefined;

    assertActive(signal);
    return canvasToJpegDataUrl(result.canvas);
  } catch (error) {
    assertActive(signal);
    if (error instanceof HlsDownloaderError) throw error;
    return undefined;
  } finally {
    input.dispose();
  }
}

async function resolvePosterTimestamp(
  videoTrack: Awaited<ReturnType<Input['getPrimaryVideoTrack']>> & {},
): Promise<number> {
  const packetSink = new EncodedPacketSink(videoTrack);
  const startTimestamp = await videoTrack.getFirstTimestamp();
  const keyPacket = await packetSink.getKeyPacket(startTimestamp);
  return keyPacket?.timestamp ?? startTimestamp;
}

function canvasToJpegDataUrl(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  quality = 0.85,
): string | undefined {
  if ('toDataURL' in canvas && typeof canvas.toDataURL === 'function') {
    return canvas.toDataURL('image/jpeg', quality);
  }

  return undefined;
}
