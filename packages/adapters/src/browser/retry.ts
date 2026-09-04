import {
  HlsDownloaderError,
  HlsDownloaderErrorCode,
  isAbortError,
  type HlsDownloaderErrorCode as ErrorCode,
} from '@hls-downloader/shared';

export function normalizeMaxAttempts(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function retryDelayMs(attempt: number, random: number = Math.random()): number {
  const base = Math.min(4_000, 250 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.9 + random * 0.2));
}

export async function waitForRetry(
  attempt: number,
  signal?: AbortSignal,
  random?: () => number,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timeout = setTimeout(
      () => {
        cleanup();
        resolve();
      },
      retryDelayMs(attempt, random?.()),
    );
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (signal?.aborted) onAbort();
    });
  });
}

type FetchWithRetryOptions = {
  url: string;
  init?: RequestInit;
  maxAttempts: number;
  errorCode: ErrorCode;
  adapter?: string;
  segmentIndex?: number;
  random?: () => number;
};

export async function fetchWithRetry({
  url,
  init,
  maxAttempts,
  errorCode,
  adapter = 'BrowserAdapter',
  segmentIndex,
  random,
}: FetchWithRetryOptions): Promise<Response> {
  const attempts = normalizeMaxAttempts(maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;

      const retryable = isRetryableStatus(response.status);
      if (!retryable || attempt === attempts) {
        throw new HlsDownloaderError(errorCode, `Request failed (${response.status})`, {
          url: response.url || url,
          status: response.status,
          segmentIndex,
          attempt,
          adapter,
          recoverable: retryable && attempt < attempts,
        });
      }
    } catch (cause) {
      if (isAbortError(cause) || init?.signal?.aborted) throw abortError(url, adapter, cause);
      if (cause instanceof HlsDownloaderError && !cause.recoverable) throw cause;
      if (attempt === attempts) {
        throw new HlsDownloaderError(errorCode, 'Request failed after all attempts', {
          url,
          segmentIndex,
          attempt,
          adapter,
          recoverable: false,
          cause,
        });
      }
    }
    await waitForRetry(attempt, init?.signal ?? undefined, random);
  }
  throw new HlsDownloaderError(errorCode, 'Request failed', { url, adapter });
}

function abortError(url?: string, adapter = 'BrowserAdapter', cause?: unknown) {
  return new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Operation aborted', {
    url,
    adapter,
    cause,
  });
}
