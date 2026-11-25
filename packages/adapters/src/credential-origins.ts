import { HlsDownloaderError, HlsDownloaderErrorCode as Code } from '@hls-downloader/shared';

export function originSet(origins: readonly string[]): Set<string> {
  return new Set(
    origins.map((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new HlsDownloaderError(Code.REQUEST_POLICY_DENIED, 'Invalid configured origin');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.href !== url.origin + '/')
        throw new HlsDownloaderError(Code.REQUEST_POLICY_DENIED, 'Expected an HTTP(S) origin');
      return url.origin;
    }),
  );
}

export function credentialHeaders(
  headers: HeadersInit | undefined,
  origin: string,
  entryOrigin: string,
  trusted: Set<string>,
): Headers {
  const result = new Headers(headers);
  if (entryOrigin !== origin && !trusted.has(origin)) {
    result.delete('authorization');
    result.delete('cookie');
  }
  return result;
}
