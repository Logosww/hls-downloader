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
import { assertActive, cancellable } from './browser/request';
import { readResource } from './browser/writable';
import {
  checkPreparedReport,
  preparedRequest,
  readManifest,
  type SelectedMedia,
  type RequestOptions,
  type PreparedReport,
} from './renditions';

export type Engine = (
  request: string,
  read: (request: string) => Promise<Uint8Array>,
  write: (bytes: Uint8Array) => Promise<void>,
  progress: (event: string) => void,
  signal: AbortSignal,
) => Promise<string>;

/** Owns request cancellation and suppresses late bridge calls, including non-cooperative sinks. */
export async function withOperation<T>(
  options: RequestOptions,
  action: (options: RequestOptions & { signal: AbortSignal }) => Promise<T>,
  adapterName = 'BrowserAdapter',
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    assertActive(controller.signal);
    return await action({ ...options, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted && controller.signal.reason instanceof HlsDownloaderError)
      throw controller.signal.reason;
    if (e instanceof HlsDownloaderError)
      throw new HlsDownloaderError(e.code, e.message, { ...e, adapter: adapterName, cause: e });
    throw e;
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function executePrepared(
  adapter: HlsDownloaderAdapterInternal,
  options: RequestOptions & { signal: AbortSignal },
  media: SelectedMedia,
  engine: Engine,
  mode: string,
  write: (bytes: Uint8Array) => Promise<void>,
  output?: string,
): Promise<PreparedReport> {
  let originalError: unknown;
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        assertActive(options.signal);
        return await cancellable(fn(...args), options.signal);
      } catch (e) {
        originalError ??= e;
        throw e;
      }
    };
  let active = true;
  try {
    const result = await engine(
      preparedRequest(
        media,
        options.downloadConcurrency ?? adapter.chunkDownloadConcurrency,
        mode,
        output,
      ),
      guard(async (request) => {
        const { url, offset, length } = JSON.parse(request);
        const resource = await readResource(
          { url, range: offset != null ? { offset, length } : undefined },
          options.headers,
          options.maxRetry ?? adapter.segmentRetryAttempts,
          options.signal,
          Code.SEGMENT_FETCH_FAILED,
          options.browserRequest,
        );
        return resource.bytes;
      }),
      guard(write),
      (event) => {
        if (!active || options.signal.aborted) return;
        const p = JSON.parse(event);
        if (p.phase === 'processing')
          emitAdapterEvent(adapter, options, Event.DOWNLOADING_SEGMENTS, {
            total: p.total,
            completed: p.completed,
          });
      },
      options.signal,
    );
    const report = JSON.parse(result) as PreparedReport;
    if (originalError) {
      if (originalError instanceof HlsDownloaderError && report.error) {
        originalError = new HlsDownloaderError(originalError.code, originalError.message, {
          ...originalError,
          adapter: adapter.name,
          inputRole: report.error.inputRole ?? undefined,
          phase: report.error.phase,
          cause: originalError,
        });
      }
      throw originalError;
    }
    assertActive(options.signal);
    return checkPreparedReport(report);
  } catch (e) {
    if (options.signal.aborted && options.signal.reason instanceof HlsDownloaderError)
      throw options.signal.reason;
    if (options.signal.aborted) assertActive(options.signal);
    throw originalError ?? e;
  } finally {
    active = false;
  }
}

export async function exportSubtitles(
  adapter: HlsDownloaderAdapterInternal,
  options: RequestOptions & HlsDownloaderSubtitleOptions & { signal: AbortSignal },
  media: SelectedMedia,
  engine: Engine,
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
  assertSupportedSegments(source.parsed.data, adapter.name);
  const report = await executePrepared(adapter, options, media, engine, 'probe', async () => {});
  const parts: { text: string; header?: string; duration: number }[] = [];
  const headers = new Map<string, string>();
  const load = async (url: string, range?: { offset: number; length: number }) =>
    new TextDecoder('utf-8', { fatal: true }).decode(
      (
        await readResource(
          { url, range },
          options.headers,
          options.maxRetry ?? adapter.segmentRetryAttempts,
          options.signal,
          Code.SEGMENT_FETCH_FAILED,
          options.browserRequest,
        )
      ).bytes,
    );
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
  const text = mergeWebVtt(parts, report.timeline);
  assertActive(options.signal);
  emitAdapterEvent(adapter, options, Event.READY_FOR_DOWNLOAD);
  return {
    text,
    mimeType: 'text/vtt' as const,
    filename: options.filename ?? 'subtitles.vtt',
    totalSegments: parts.length,
  };
}
