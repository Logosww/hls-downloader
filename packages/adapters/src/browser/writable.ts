import { Parser } from 'm3u8-parser';
import {
  HlsDownloaderError,
  HlsDownloaderErrorCode,
  mapManifest,
  assertSupportedSegments,
  selectBestVariant,
  type Segment,
  type HlsDownloaderWritableOptions,
} from '@hls-downloader/shared';
import { normalizeMaxAttempts, isRetryableStatus, waitForRetry } from './retry';

type Resource = { url: string; range?: { offset: number; length: number } };
const failure = (code: HlsDownloaderErrorCode, message: string, url: string, cause?: unknown) =>
  new HlsDownloaderError(code, message, { url, cause, adapter: 'BrowserAdapter' });

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/** Includes body consumption in the attempt; partial bodies are never published. */
export async function readResource(
  resource: Resource,
  headers: Record<string, string> | undefined,
  maxRetry: number,
  signal: AbortSignal,
  code: HlsDownloaderErrorCode = HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
): Promise<{ bytes: Uint8Array; url: string }> {
  const attempts = normalizeMaxAttempts(maxRetry);
  for (let attempt = 1; ; attempt++) {
    checkSignal(signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let retryable = true;
    try {
      const requestHeaders = new Headers(headers);
      const range = resource.range;
      if (range)
        requestHeaders.set('Range', `bytes=${range.offset}-${range.offset + range.length - 1}`);
      const response = await fetch(resource.url, { headers: requestHeaders, signal, mode: 'cors' });
      reader = response.body?.getReader();
      if (!response.ok) {
        retryable = isRetryableStatus(response.status);
        throw new HlsDownloaderError(code, `Request failed (${response.status})`, {
          url: resource.url,
          status: response.status,
          attempt,
          adapter: 'BrowserAdapter',
        });
      }
      if (range && response.status === 206) {
        const match = response.headers
          .get('content-range')
          ?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i);
        if (
          !match ||
          +match[1]! !== range.offset ||
          +match[2]! !== range.offset + range.length - 1
        ) {
          retryable = false;
          throw failure(code, 'Range response does not match request', resource.url);
        }
      } else if (range && response.status !== 200) {
        retryable = false;
        throw failure(code, 'Server did not satisfy byte range request', resource.url);
      }
      const skip = range && response.status === 200 ? range.offset : 0;
      const limit = range?.length ?? Infinity;
      const chunks: Uint8Array[] = [];
      let position = 0;
      let size = 0;
      // Range responses use a fixed allocation; full bodies retain only this segment.
      const rangedBytes = range ? new Uint8Array(range.length) : undefined;
      while (reader) {
        const { done, value } = await reader.read();
        checkSignal(signal);
        if (done) break;
        const start = Math.max(0, skip - position);
        const end = Math.min(value.length, skip + limit - position);
        if (end > start) {
          const part = value.subarray(start, end);
          if (rangedBytes) rangedBytes.set(part, size);
          else chunks.push(part);
          size += part.length;
        }
        position += value.length;
        if (range && response.status === 200 && size === limit) break;
        if (range && response.status === 206 && position > limit) {
          retryable = false;
          throw failure(code, 'Range response is too long', resource.url);
        }
      }
      if (range && size !== range.length)
        throw failure(code, 'Incomplete byte range', resource.url);
      const bytes = rangedBytes ?? new Uint8Array(size);
      if (!rangedBytes) {
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      }
      return { bytes, url: response.url || resource.url };
    } catch (cause) {
      checkSignal(signal);
      if (!retryable || attempt >= attempts) {
        if (cause instanceof HlsDownloaderError) throw cause;
        throw failure(code, 'Resource download failed', resource.url, cause);
      }
    } finally {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* connection already terminated */
        }
        reader.releaseLock();
      }
    }
    await waitForRetry(attempt, signal);
  }
}

/** Resolve once, keeping the exact validated media snapshot used by the WASM parser. */
export async function resolveWritablePlaylist(
  options: HlsDownloaderWritableOptions & { maxRetry: number; signal: AbortSignal },
): Promise<{ playlist: string; url: string; segments: Segment[] }> {
  let url = options.url;
  const visited = new Set<string>();
  for (let depth = 0; depth <= 8; depth++) {
    if (visited.has(url))
      throw failure(HlsDownloaderErrorCode.MANIFEST_INVALID, 'Master playlist cycle', url);
    visited.add(url);
    const resource = await readResource(
      { url },
      options.headers,
      options.maxRetry,
      options.signal,
      HlsDownloaderErrorCode.MANIFEST_FETCH_FAILED,
    );
    url = resource.url;
    visited.add(url);
    const playlist = new TextDecoder().decode(resource.bytes);
    const parser = new Parser();
    let parsed;
    try {
      parser.push(playlist);
      parser.end();
      // Normalize before mapManifest: its legacy base argument is a literal
      // {{URL}} template, not a URL (URL() percent-encodes those braces).
      for (const variant of parser.manifest.playlists ?? []) {
        variant.uri = new URL(variant.uri, url).href;
      }
      for (const segment of parser.manifest.segments ?? []) {
        segment.uri = new URL(segment.uri, url).href;
        if (segment.map?.uri) segment.map.uri = new URL(segment.map.uri, url).href;
      }
      parsed = mapManifest(parser.manifest, new URL('.', url).href + '{{URL}}');
    } catch (cause) {
      throw failure(HlsDownloaderErrorCode.MANIFEST_INVALID, 'Invalid playlist', url, cause);
    }
    if (parsed.type === 'segment') {
      assertSupportedSegments(parsed.data, 'BrowserAdapter');
      return { playlist, url, segments: parsed.data };
    }
    if (parsed.type === 'error')
      throw (
        parsed.error ??
        failure(HlsDownloaderErrorCode.MANIFEST_INVALID, parsed.message ?? 'Invalid playlist', url)
      );
    const variant = selectBestVariant(parsed.data, options.variant);
    if (!variant) throw failure(HlsDownloaderErrorCode.NO_VARIANT, 'No variant available', url);
    if (variant.hasAlternateRenditions)
      throw failure(
        HlsDownloaderErrorCode.TRANSMUX_FAILED,
        'Alternate renditions are not supported',
        url,
      );
    url = variant.uri;
  }
  throw failure(
    HlsDownloaderErrorCode.MANIFEST_INVALID,
    'Master playlist recursion limit exceeded',
    url,
  );
}

function segmentResource(segment: Segment): Resource {
  return { url: segment.uri, range: segment.byterange };
}
function key(resource: Resource): string {
  return `${resource.url}\0${resource.range ? `${resource.range.offset}:${resource.range.length}` : 'full'}`;
}

/** The window counts in-flight AND ready entries. It moves only on consumption. */
export function createResourceWindow(
  segments: Segment[],
  concurrency: number,
  read: (resource: Resource) => Promise<Uint8Array>,
  signal: AbortSignal,
  onProgress: (completed: number) => void,
) {
  const limit = Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1));
  const pending = new Map<number, Promise<Uint8Array>>();
  let next = 0;
  let consumed = 0;
  let completed = 0;
  let peak = 0;
  let disposed = false;
  function fill() {
    while (!disposed && !signal.aborted && next < segments.length && pending.size < limit) {
      const index = next++;
      const promise = read(segmentResource(segments[index]!)).then((bytes) => {
        checkSignal(signal);
        if (!disposed) onProgress(++completed);
        return bytes;
      });
      // Observe speculative failures immediately; propagate when consumed.
      void promise.catch(() => {});
      pending.set(index, promise);
      peak = Math.max(peak, pending.size);
    }
  }
  return {
    get peak(): number {
      return peak;
    },
    get size(): number {
      return pending.size;
    },
    async read(url: string, offset?: number, length?: number): Promise<Uint8Array> {
      checkSignal(signal);
      if (disposed) throw new Error('Resource window has ended');
      const resource: Resource = {
        url,
        range: offset === undefined ? undefined : { offset, length: length! },
      };
      // Source reads media in playlist order; map reads do not advance the window.
      if (
        consumed < segments.length &&
        key(resource) === key(segmentResource(segments[consumed]!))
      ) {
        fill();
        const bytes = await pending.get(consumed)!;
        pending.delete(consumed++);
        fill();
        return bytes;
      }
      return await read(resource);
    },
    dispose(): void {
      disposed = true;
      pending.clear();
    },
  };
}
