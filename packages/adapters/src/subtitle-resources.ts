import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type HlsDownloaderAdapterInternal,
  type HlsWebVttPart,
} from '@hls-downloader/shared';
import { executeKeyed, type KeyedEngine } from './keyed';
import { checkRecording, type RecordingBridgeFactory } from './recording';
import type { RequestOptions } from './renditions';

/** Resource-only export with an existing timeline. No primary media is fetched. */
export async function readSubtitleParts(
  adapter: HlsDownloaderAdapterInternal,
  options: RequestOptions & { signal: AbortSignal; maxBytes?: number },
  snapshot: { url: string; text: string },
  factory: RecordingBridgeFactory,
): Promise<HlsWebVttPart[]> {
  const metadata = await adapter.parseMediaPlaylist!(snapshot.text, snapshot.url);
  if (!metadata.endList || metadata.segments.some((s) => s.gap))
    throw new HlsDownloaderError(
      Code.UNSUPPORTED_RENDITION,
      'Finite subtitle playlist without gaps required',
    );
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Invalid subtitle collection limit');
  const parts: HlsWebVttPart[] = [];
  let size = 0;
  const engine: KeyedEngine = async (request, read, write, resolve, abort) => {
    const bridge = await factory(
      JSON.stringify({
        ...JSON.parse(request),
        bridgeVersion: 3,
        recording: { vod: true, outputType: 'writable', format: 'fmp4', limits: {}, timeline: {} },
        multitrack: {
          embeddedAudio: 'keep',
          primaryAudio: {},
          audioTracks: [],
          subtitleTracks: [{ id: 'subtitle', timelineInputId: 'primary', metadata: {} }],
        },
      }),
      read,
      write,
      resolve,
      abort,
      async () => '',
    );
    const cancel = () => {
      void bridge.command('{"action":"cancel"}').catch(() => {});
    };
    options.signal.addEventListener('abort', cancel, { once: true });
    try {
      for (const [index, segment] of metadata.segments.entries()) {
        const resource = checkRecording(
          await bridge.command(
            JSON.stringify({ action: 'subtitleResource', inputId: 'subtitle', ...snapshot, index }),
          ),
        );
        size +=
          new TextEncoder().encode(resource.text).length +
          new TextEncoder().encode(resource.header ?? '').length;
        if (size > maxBytes)
          throw new HlsDownloaderError(
            Code.RESOURCE_LIMIT_EXCEEDED,
            'Subtitle collection exceeds maxBytes',
          );
        parts.push({
          text: resource.text,
          header: resource.header ?? undefined,
          epoch: segment.epoch,
          programDateTime: segment.programDateTime,
          duration: segment.duration,
        });
      }
      return JSON.stringify({ totalSegments: parts.length });
    } finally {
      options.signal.removeEventListener('abort', cancel);
      await bridge.command('{"action":"cancel"}').catch(() => {});
      await bridge.run().catch(() => {});
      bridge.dispose();
    }
  };
  await executeKeyed(
    adapter,
    options,
    { primary: { ...snapshot, segments: [] }, subtitles: [], totalSegments: 0 },
    engine,
    'continuous',
    async () => {},
  );
  return parts;
}
