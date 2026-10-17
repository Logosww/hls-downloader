import { HlsDownloaderError } from '@hls-downloader/shared';
import { assertActive } from './browser/request';
import type { RequestOptions } from './renditions';

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
      throw new HlsDownloaderError(e.code, e.message, { ...e, adapter: adapterName });
    throw e;
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', abort);
  }
}
