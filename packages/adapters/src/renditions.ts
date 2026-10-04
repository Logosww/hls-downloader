import { Parser } from 'm3u8-parser';
import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  mapManifest,
  selectBestVariant,
  assertSupportedSegments,
  type AudioSelection,
  type Rendition,
  type Segment,
  type HlsDownloaderDownloadOptions,
  type HlsDownloaderFetchOptions,
  type HlsDownloaderBrowserOperationOptions,
  type ParseHlsResult,
} from '@hls-downloader/shared';
import { readResource } from './browser/writable';

export type MediaSnapshot = { url: string; text: string; segments: Segment[] };
export type SelectedMedia = {
  primary: MediaSnapshot;
  audio?: MediaSnapshot;
  subtitles: Rendition[];
  totalSegments: number;
};
export type RequestOptions = HlsDownloaderFetchOptions &
  HlsDownloaderDownloadOptions &
  HlsDownloaderBrowserOperationOptions;

export function parseManifest(text: string, url: string): ParseHlsResult {
  if (!text.trimStart().startsWith('#EXTM3U'))
    throw new HlsDownloaderError(Code.MANIFEST_INVALID, 'Missing EXTM3U header', { url });
  const parser = new Parser();
  parser.push(text);
  parser.end();
  for (const p of parser.manifest.playlists ?? []) p.uri = new URL(p.uri, url).href;
  for (const s of parser.manifest.segments ?? []) {
    s.uri = new URL(s.uri, url).href;
    if (s.map?.uri) s.map.uri = new URL(s.map.uri, url).href;
  }
  return mapManifest(parser.manifest, new URL('.', url).href + '{{URL}}');
}
export async function readManifest(
  url: string,
  options: RequestOptions,
): Promise<{ url: string; text: string; parsed: ParseHlsResult }> {
  const result = await readResource(
    { url },
    options.headers,
    options.maxRetry ?? 10,
    options.signal ?? new AbortController().signal,
    Code.MANIFEST_FETCH_FAILED,
    options.browserRequest,
  );
  const text = new TextDecoder().decode(result.bytes);
  try {
    return { url: result.url, text, parsed: parseManifest(text, result.url) };
  } catch (cause) {
    throw cause instanceof HlsDownloaderError
      ? cause
      : new HlsDownloaderError(Code.MANIFEST_INVALID, 'Invalid playlist', {
          url: result.url,
          cause,
        });
  }
}
export function selectAudio(
  renditions: Rendition[],
  group: string | undefined,
  selection?: AudioSelection,
): Rendition | undefined {
  let candidates = renditions.filter(
    (r) => r.type === 'audio' && group !== undefined && r.groupId === group,
  );
  if (selection)
    candidates = candidates.filter((r) =>
      'language' in selection
        ? r.language?.toLowerCase() === selection.language.toLowerCase()
        : r.groupId === selection.groupId && r.name === selection.name,
    );
  if (!candidates.length && (selection || group !== undefined))
    throw new HlsDownloaderError(
      Code.RENDITION_NOT_FOUND,
      'Selected audio rendition is unavailable',
    );
  return candidates
    .map((r, index) => ({ r, index }))
    .sort(
      (a, b) =>
        Number(b.r.default) - Number(a.r.default) ||
        Number(b.r.autoselect) - Number(a.r.autoselect) ||
        a.index - b.index,
    )[0]?.r;
}
export async function resolveMedia(
  options: RequestOptions,
  rejectAlternate = false,
): Promise<SelectedMedia> {
  let url = options.url;
  let audio: Rendition | undefined;
  let subtitles: Rendition[] = [];
  let selected = false;
  const visited = new Set<string>();
  for (let depth = 0; depth <= 8; depth++) {
    if (visited.has(url))
      throw new HlsDownloaderError(Code.MANIFEST_INVALID, 'Master playlist cycle', { url });
    visited.add(url);
    const resource = await readManifest(url, options);
    visited.add(resource.url);
    const { parsed } = resource;
    if (parsed.type === 'error')
      throw parsed.error ?? new HlsDownloaderError(Code.MANIFEST_INVALID, parsed.message);
    if (parsed.type === 'playlist') {
      const variant = selectBestVariant(parsed.data, options.variant);
      if (!variant) throw new HlsDownloaderError(Code.NO_VARIANT, 'No variant available', { url });
      if (variant.videoGroup)
        throw new HlsDownloaderError(
          Code.UNSUPPORTED_RENDITION,
          'Alternate video groups are unsupported',
        );
      if (variant.audioGroup !== undefined) {
        audio = selectAudio(parsed.renditions ?? [], variant.audioGroup, options.audio);
        selected = true;
      }
      if (variant.subtitlesGroup !== undefined)
        subtitles = (parsed.renditions ?? []).filter(
          (r) => r.type === 'subtitles' && r.groupId === variant.subtitlesGroup,
        );
      if (rejectAlternate && (audio?.uri || options.audio))
        throw new HlsDownloaderError(
          Code.UNSUPPORTED_OUTPUT,
          'Audio selection is incompatible with this output',
        );
      url = variant.uri;
      continue;
    }
    if (!selected && options.audio)
      throw new HlsDownloaderError(
        Code.RENDITION_NOT_FOUND,
        'Audio selection requires a master playlist',
      );
    assertSupportedSegments(parsed.data, 'HlsDownloader');
    const primary = { url: resource.url, text: resource.text, segments: parsed.data };
    let external: MediaSnapshot | undefined;
    if (audio?.uri) {
      const a = await readManifest(audio.uri, options);
      if (a.parsed.type !== 'segment')
        throw new HlsDownloaderError(
          Code.MANIFEST_INVALID,
          'Audio rendition must be a media playlist',
          { inputRole: 'audio' },
        );
      assertSupportedSegments(a.parsed.data, 'HlsDownloader');
      external = { url: a.url, text: a.text, segments: a.parsed.data };
    }
    return {
      primary,
      audio: external,
      subtitles,
      totalSegments: primary.segments.length + (external?.segments.length ?? 0),
    };
  }
  throw new HlsDownloaderError(Code.MANIFEST_INVALID, 'Master playlist recursion limit exceeded');
}

export type Timeline = {
  origin: { ticks: string; timescale: number };
  tracks: { role: string; timescale: number; editOffset: string; wrapAnchor?: string | null }[];
};
export type PreparedReport = {
  totalSegments: number;
  timeline: Timeline;
  error?: {
    code: string;
    inputRole?: 'primary' | 'audio';
    phase?: string;
    segmentIndex?: number;
    url?: string;
  };
};
export function checkPreparedReport(report: PreparedReport): PreparedReport {
  if (report.error) {
    const { code, ...details } = report.error;
    throw new HlsDownloaderError(
      code as Code,
      `Media processing failed (${details.phase ?? 'prepare'})`,
      {
        ...details,
        inputRole: details.inputRole ?? undefined,
        segmentIndex: details.segmentIndex ?? undefined,
        url: details.url ?? undefined,
      },
    );
  }
  return report;
}
export function preparedRequest(
  media: SelectedMedia,
  concurrency: number,
  mode: string,
  output?: string,
): string {
  return JSON.stringify({
    primary: { url: media.primary.url, text: media.primary.text },
    audio: media.audio ? { url: media.audio.url, text: media.audio.text } : null,
    concurrency: Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1)),
    mode,
    output,
  });
}
