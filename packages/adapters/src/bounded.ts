import { HlsDownloaderError, HlsDownloaderErrorCode as Code } from '@hls-downloader/shared';
import type { HlsDownloaderBrowserRequestOptions } from '@hls-downloader/shared';
import { assertActive, cancellable, requestMedia } from './browser/request';
import { normalizeMaxAttempts, isRetryableStatus, waitForRetry } from './browser/retry';

/** Bounds bytes while consuming the body; protocol offsets never pass through Number. */
export async function readBoundedResource(
  resource: { url: string; offset?: string | null; length?: string | null },
  maxBytes: number,
  headers: Record<string, string> | undefined,
  maxRetry: number,
  signal: AbortSignal,
  code: Code = Code.SEGMENT_FETCH_FAILED,
  transport?: HlsDownloaderBrowserRequestOptions,
): Promise<{ bytes: Uint8Array; url: string }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Invalid resource limit');
  const offset = resource.offset == null ? undefined : BigInt(resource.offset);
  const length = resource.length == null ? undefined : BigInt(resource.length);
  if (offset !== undefined && (offset < 0n || length === undefined || length <= 0n))
    throw new HlsDownloaderError(Code.ENCRYPTION_INVALID, 'Invalid byte range');
  if (length !== undefined && length > BigInt(maxBytes))
    throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Resource exceeds byte limit');
  const capCode =
    code === Code.KEY_RESOLUTION_FAILED ? Code.KEY_INVALID : Code.RESOURCE_LIMIT_EXCEEDED;
  for (let attempt = 1; ; attempt++) {
    assertActive(signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let retryable = true;
    try {
      const requestHeaders = new Headers(headers);
      if (offset !== undefined)
        requestHeaders.set('Range', `bytes=${offset}-${offset + length! - 1n}`);
      const response = await requestMedia(
        resource.url,
        { headers: requestHeaders, signal, mode: 'cors' },
        transport,
      );
      reader = response.body?.getReader();
      if (!response.ok) {
        retryable = isRetryableStatus(response.status);
        throw new HlsDownloaderError(code, 'Resource request failed', {
          status: response.status,
          attempt,
        });
      }
      if (offset !== undefined) {
        const match = response.headers
          .get('content-range')
          ?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
        if (
          response.status !== 206 ||
          !match ||
          BigInt(match[1]!) !== offset ||
          BigInt(match[2]!) !== offset + length! - 1n ||
          (match[3] !== '*' && BigInt(match[3]!) <= BigInt(match[2]!))
        ) {
          retryable = false;
          throw new HlsDownloaderError(code, 'Range response does not match request');
        }
      }
      const declared = response.headers.get('content-length');
      if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maxBytes)) {
        retryable = false;
        throw new HlsDownloaderError(capCode, 'Resource exceeds byte limit');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const part = await cancellable(reader.read(), signal);
        assertActive(signal);
        if (part.done) break;
        if (part.value.length > maxBytes - size) {
          retryable = false;
          throw new HlsDownloaderError(capCode, 'Resource exceeds byte limit');
        }
        size += part.value.length;
        if (length !== undefined && BigInt(size) > length) {
          retryable = false;
          throw new HlsDownloaderError(code, 'Range response is too long');
        }
        chunks.push(part.value);
      }
      if (length !== undefined && BigInt(size) !== length)
        throw new HlsDownloaderError(code, 'Incomplete byte range');
      const bytes = new Uint8Array(size);
      let position = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, position);
        position += chunk.length;
      }
      return { bytes, url: response.url || resource.url };
    } catch (error) {
      assertActive(signal);
      if (!retryable || attempt >= normalizeMaxAttempts(maxRetry))
        throw error instanceof HlsDownloaderError
          ? error
          : new HlsDownloaderError(code, 'Resource request failed', { attempt });
    } finally {
      if (reader) {
        try {
          void reader.cancel().catch(() => {});
        } catch {
          /* already cancelled */
        }
        try {
          reader.releaseLock();
        } catch {
          /* pending non-cooperative read */
        }
      }
    }
    await waitForRetry(attempt, signal);
  }
}
