import {
  HlsDownloaderError,
  HlsDownloaderErrorCode,
  type HlsDownloaderBrowserRequestOptions,
} from '@hls-downloader/shared';

export function assertActive(signal?: AbortSignal | null): void {
  if (signal?.aborted)
    throw new HlsDownloaderError(HlsDownloaderErrorCode.ABORTED, 'Operation aborted', {
      adapter: 'BrowserAdapter',
    });
}

/** Observe late rejections and discard late results even for a non-cooperative transport. */
export async function cancellable<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null,
  discard?: (value: T) => void,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const observed = promise.then((value) => {
    if (signal?.aborted) {
      discard?.(value);
      assertActive(signal);
    }
    return value;
  });
  try {
    return await Promise.race([
      observed,
      new Promise<never>((_, reject) => {
        onAbort = () => {
          try {
            assertActive(signal);
          } catch (error) {
            reject(error);
          }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export async function requestMedia(
  url: string,
  init: RequestInit,
  request?: HlsDownloaderBrowserRequestOptions,
): Promise<Response> {
  assertActive(init.signal);
  const transport = request?.fetch ?? globalThis.fetch;
  const pending = Promise.resolve().then(() => {
    assertActive(init.signal);
    return transport(url, {
      ...init,
      ...(request?.credentials === undefined ? {} : { credentials: request.credentials }),
    });
  });
  return cancellable(pending, init.signal, (response) => {
    void response.body?.cancel().catch(() => {});
  });
}
