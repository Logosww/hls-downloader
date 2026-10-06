import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  mapTimelineWebVtt,
  type HlsDownloaderAdapterInternal,
  type HlsDownloaderSubtitleOutputsOptions,
  type HlsDownloaderBrowserOperationOptions,
  type HlsWebVttPart,
} from '@hls-downloader/shared';
import { readManifest, resolveMedia } from './renditions';
import { readBoundedResource } from './bounded';
import { assertActive } from './browser/request';
export async function exportTimelineSubtitles(
  adapter: HlsDownloaderAdapterInternal,
  options: HlsDownloaderSubtitleOutputsOptions &
    HlsDownloaderBrowserOperationOptions & { signal: AbortSignal },
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
  const playlist = await adapter.parseMediaPlaylist(source.text, source.url);
  if (
    !playlist.endList ||
    playlist.playlistType === 'Event' ||
    playlist.segments.some((s) => s.gap || s.keys.length || s.map?.keys.length)
  )
    throw new HlsDownloaderError(
      Code.UNSUPPORTED_RENDITION,
      'Timeline subtitles require finite clear WebVTT',
    );
  const headers = new Map<string, string>(),
    parts: HlsWebVttPart[] = [];
  const load = async (resource: {
    uri: string;
    range: { offset: string; length: string } | null;
  }) =>
    new TextDecoder('utf-8', { fatal: true }).decode(
      (
        await readBoundedResource(
          { url: resource.uri, offset: resource.range?.offset, length: resource.range?.length },
          16 * 1024 * 1024,
          options.headers,
          options.maxRetry ?? adapter.segmentRetryAttempts,
          options.signal,
          Code.SEGMENT_FETCH_FAILED,
          options.browserRequest,
        )
      ).bytes,
    );
  for (const segment of playlist.segments) {
    let header: string | undefined;
    if (segment.map) {
      const id = JSON.stringify([segment.map.uri, segment.map.range]);
      header = headers.get(id);
      if (header === undefined) {
        header = await load(segment.map);
        headers.set(id, header);
      }
    }
    parts.push({
      text: await load(segment),
      header,
      epoch: segment.epoch,
      programDateTime: segment.programDateTime,
      duration: segment.duration,
    });
  }
  assertActive(options.signal);
  return {
    outputs: mapTimelineWebVtt(parts, options.timelineReport, options.track, options.filename),
    totalSegments: parts.length,
  };
}
