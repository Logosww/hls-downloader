import {
  ALL_FORMATS,
  BufferSource,
  CanvasSink,
  EncodedPacketSink,
  Input,
} from 'mediabunny';

export type ExtractPosterFromSegmentOptions = {
  segmentUrl: string;
  headers?: Record<string, string>;
};

export async function extractPosterFromSegmentUrl({
  segmentUrl,
  headers,
}: ExtractPosterFromSegmentOptions): Promise<string | undefined> {
  const segmentBuffer = await fetchSegmentBuffer(segmentUrl, headers);
  if (!segmentBuffer) return undefined;

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

    return canvasToJpegDataUrl(result.canvas);
  } catch {
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

async function fetchSegmentBuffer(
  url: string,
  headers?: Record<string, string>,
): Promise<ArrayBuffer | undefined> {
  try {
    const response = await fetch(url, {
      headers,
      mode: 'cors',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    return await response.arrayBuffer();
  } catch {
    return undefined;
  }
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
