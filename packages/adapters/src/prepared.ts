import { runMultiTrack } from './multitrack';
import { finiteEngine } from './engine';
import { mergeWebVtt } from './subtitles';
import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  HlsDownloaderEvent as Event,
  emitAdapterEvent,
  assertSupportedSegments,
  type HlsDownloaderSubtitleResult,
  type HlsDownloaderAdapterInternal,
  type HlsDownloaderSubtitleOptions,
} from '@hls-downloader/shared';
import { assertActive } from './browser/request';
import { readBoundedResource } from './bounded';
import { readManifest, type SelectedMedia, type RequestOptions } from './renditions';

export { withOperation } from './operation';

export async function exportSubtitles(
  adapter: HlsDownloaderAdapterInternal,
  options: RequestOptions & HlsDownloaderSubtitleOptions & { signal: AbortSignal },
  media: SelectedMedia,
  engine: import('./recording').RecordingBridgeFactory,
): Promise<Omit<HlsDownloaderSubtitleResult, 'operationId'>> {
  const rendition = media.subtitles.find(
    (r) => r.groupId === options.subtitle.groupId && r.name === options.subtitle.name,
  );
  if (!rendition)
    throw new HlsDownloaderError(
      Code.RENDITION_NOT_FOUND,
      'Selected subtitle rendition is unavailable',
    );
  if (!rendition.uri)
    throw new HlsDownloaderError(
      Code.UNSUPPORTED_RENDITION,
      'Subtitles require an external WebVTT playlist',
    );
  const source = await readManifest(rendition.uri, options);
  if (source.parsed.type !== 'segment')
    throw new HlsDownloaderError(Code.SUBTITLE_INVALID, 'Subtitles require a media playlist');
  const metadata = await adapter.parseMediaPlaylist!(source.text, source.url);
  if (metadata.segments.some((s) => s.keys.length || s.map?.keys.length)) {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new HlsDownloaderError(
        Code.RESOURCE_LIMIT_EXCEEDED,
        'Invalid subtitle collection limit',
      );
    await runMultiTrack(
      adapter,
      {
        ...options,
        transcode: undefined,
        timeline: undefined,
        audio: undefined,
        embeddedAudio: options.audio ? 'exclude' : 'keep',
        audioTracks: options.audio ? [{ id: 'audio', selector: options.audio }] : [],
        subtitleTracks: [
          {
            id: 'subtitle',
            selector: options.subtitle,
            embedded: false,
            sidecar: {
              type: 'writable',
              writable: new WritableStream<Uint8Array>({
                write(chunk) {
                  bytes += chunk.byteLength;
                  if (bytes > maxBytes)
                    throw new HlsDownloaderError(
                      Code.RESOURCE_LIMIT_EXCEEDED,
                      'Subtitle collection exceeds maxBytes',
                    );
                  chunks.push(chunk);
                },
              }),
            },
          },
        ],
        output: { type: 'writable', writable: undefined as never },
      },
      {
        ready() {},
        async write() {},
        async control() {
          return '';
        },
      },
      engine,
      true,
      !options.audio,
    );
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    emitAdapterEvent(adapter, options, Event.READY_FOR_DOWNLOAD);
    return {
      text: new TextDecoder().decode(buffer),
      mimeType: 'text/vtt',
      filename: options.filename ?? 'subtitles.vtt',
      totalSegments: metadata.segments.length,
    };
  }
  assertSupportedSegments(source.parsed.data, adapter.name);

  const { report } = await finiteEngine(
    adapter,
    options,
    { type: 'writable', writable: undefined as never },
    engine,
  );
  const track = report.tracks.find((t) => t.kind === 'video') ?? report.tracks[0];
  const mapping = report.mappings.find(
    (m) => m.inputId === track?.inputId && m.trackId === track.id,
  );
  if (!mapping) throw new HlsDownloaderError(Code.SUBTITLE_INVALID, 'Missing media mapping');
  const parts: { text: string; header?: string; duration: number }[] = [];
  const headers = new Map<string, string>();
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Invalid subtitle collection limit');
  let collectedBytes = 0;
  const load = async (url: string, range?: { offset: number; length: number }) => {
    const resource = await readBoundedResource(
      { url, offset: range?.offset.toString(), length: range?.length.toString() },
      maxBytes,
      options.headers,
      options.maxRetry ?? adapter.segmentRetryAttempts,
      options.signal,
      Code.SEGMENT_FETCH_FAILED,
      options.browserRequest,
    );
    collectedBytes += resource.bytes.byteLength;
    if (collectedBytes > maxBytes)
      throw new HlsDownloaderError(
        Code.RESOURCE_LIMIT_EXCEEDED,
        'Subtitle collection exceeds maxBytes',
      );
    return new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes);
  };
  for (const segment of source.parsed.data) {
    let header: string | undefined;
    if (segment.map) {
      const key = JSON.stringify([segment.map.uri, segment.map.byterange]);
      header = headers.get(key);
      if (header === undefined) {
        header = await load(segment.map.uri, segment.map.byterange);
        headers.set(key, header);
      }
    }
    parts.push({
      text: await load(segment.uri, segment.byterange),
      header,
      duration: segment.duration,
    });
    emitAdapterEvent(adapter, options, Event.DOWNLOADING_SEGMENTS, {
      completed: parts.length,
      total: source.parsed.data.length,
    });
  }
  const text = mergeWebVtt(parts, {
    origin: mapping.sourceStart,
    outputStart: mapping.outputStart,
    tracks: [
      {
        wrapAnchor: (
          (BigInt(mapping.sourceStart.ticks) * 90000n) /
          BigInt(mapping.sourceStart.timescale)
        ).toString(),
      },
    ],
  });
  if (new TextEncoder().encode(text).length > maxBytes)
    throw new HlsDownloaderError(
      Code.RESOURCE_LIMIT_EXCEEDED,
      'Subtitle collection exceeds maxBytes',
    );
  assertActive(options.signal);
  emitAdapterEvent(adapter, options, Event.READY_FOR_DOWNLOAD);
  return {
    text,
    mimeType: 'text/vtt' as const,
    filename: options.filename ?? 'subtitles.vtt',
    totalSegments: parts.length,
  };
}
