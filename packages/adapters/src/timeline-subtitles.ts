import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  mapTimelineWebVtt,
  type HlsDownloaderAdapterInternal,
  type HlsDownloaderSubtitleOutputsOptions,
  type HlsDownloaderBrowserOperationOptions,
} from '@hls-downloader/shared';
import { readManifest, resolveMedia } from './renditions';
import { readSubtitleParts } from './subtitle-resources';
import type { RecordingBridgeFactory } from './recording';
import { assertActive } from './browser/request';
export async function exportTimelineSubtitles(
  adapter: HlsDownloaderAdapterInternal,
  options: HlsDownloaderSubtitleOutputsOptions &
    HlsDownloaderBrowserOperationOptions & { signal: AbortSignal },
  factory: RecordingBridgeFactory,
) {
  const media = await resolveMedia({ ...options, timeline: {} }, false, true);
  const rendition = media.subtitles.find(
    (r) => r.groupId === options.subtitle.groupId && r.name === options.subtitle.name,
  );
  if (!rendition)
    throw new HlsDownloaderError(
      Code.RENDITION_NOT_FOUND,
      'Selected subtitle rendition unavailable',
    );
  if (!rendition.uri || !adapter.parseMediaPlaylist)
    throw new HlsDownloaderError(Code.UNSUPPORTED_RENDITION, 'External WebVTT playlist required');
  const source = await readManifest(rendition.uri, options);
  const parts = await readSubtitleParts(adapter, options, source, factory);
  assertActive(options.signal);
  const outputs = mapTimelineWebVtt(parts, options.timelineMap, options.track, options.filename);
  const bytes = outputs.reduce(
    (total, output) => total + new TextEncoder().encode(output.text).length,
    0,
  );
  if (bytes > (options.maxBytes ?? 16 * 1024 * 1024))
    throw new HlsDownloaderError(
      Code.RESOURCE_LIMIT_EXCEEDED,
      'Subtitle collection exceeds maxBytes',
    );
  return {
    outputs,
    totalSegments: parts.length,
  };
}
