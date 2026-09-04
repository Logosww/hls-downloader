import { afterEach, describe, expect, it, vi } from 'vitest';
import { HlsDownloaderErrorCode } from '@hls-downloader/shared';
import {
  fetchWithRetry,
  isRetryableStatus,
  normalizeMaxAttempts,
  retryDelayMs,
} from '../packages/adapters/src/browser/retry';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser retry contract', () => {
  it('uses maxRetry as total attempts and retries transient statuses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const responsePromise = fetchWithRetry({
      url: 'https://example.test/segment.ts',
      maxAttempts: 2,
      errorCode: HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
      random: () => 0.5,
    });
    await vi.runAllTimersAsync();

    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable 4xx responses', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRetry({
        url: 'https://example.test/missing.ts?token=secret',
        maxAttempts: 4,
        errorCode: HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
      }),
    ).rejects.toMatchObject({
      code: HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
      status: 404,
      attempt: 1,
      url: 'https://example.test/missing.ts',
      recoverable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('interrupts retry backoff when aborted', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 500 })),
    );
    const controller = new AbortController();
    const request = fetchWithRetry({
      url: 'https://example.test/segment.ts',
      init: { signal: controller.signal },
      maxAttempts: 3,
      errorCode: HlsDownloaderErrorCode.SEGMENT_FETCH_FAILED,
    });
    await Promise.resolve();
    controller.abort();

    await expect(request).rejects.toMatchObject({
      name: 'AbortError',
      code: HlsDownloaderErrorCode.ABORTED,
    });
  });

  it('normalizes attempts and retry policy constants', () => {
    expect(normalizeMaxAttempts(0)).toBe(1);
    expect(normalizeMaxAttempts(2.9)).toBe(2);
    expect(retryDelayMs(1, 0.5)).toBe(250);
    expect(retryDelayMs(10, 0.5)).toBe(4_000);
    expect([408, 425, 429, 500, 599].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 404].some(isRetryableStatus)).toBe(false);
  });
});
