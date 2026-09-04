export const HlsDownloaderErrorCode = {
  MANIFEST_FETCH_FAILED: 'MANIFEST_FETCH_FAILED',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  NO_VARIANT: 'NO_VARIANT',
  SEGMENT_FETCH_FAILED: 'SEGMENT_FETCH_FAILED',
  UNSUPPORTED_ENCRYPTION: 'UNSUPPORTED_ENCRYPTION',
  TRANSMUX_FAILED: 'TRANSMUX_FAILED',
  TRANSCODE_FAILED: 'TRANSCODE_FAILED',
  ABORTED: 'ABORTED',
} as const;

export type HlsDownloaderErrorCode =
  (typeof HlsDownloaderErrorCode)[keyof typeof HlsDownloaderErrorCode];

export type HlsDownloaderErrorDetails = {
  url?: string;
  status?: number;
  segmentIndex?: number;
  attempt?: number;
  adapter?: string;
  recoverable?: boolean;
  cause?: unknown;
};

export function sanitizeHlsUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

export class HlsDownloaderError extends Error {
  readonly code: HlsDownloaderErrorCode;
  readonly url?: string;
  readonly status?: number;
  readonly segmentIndex?: number;
  readonly attempt?: number;
  readonly adapter?: string;
  readonly recoverable: boolean;

  constructor(
    code: HlsDownloaderErrorCode,
    message: string,
    details: HlsDownloaderErrorDetails = {},
  ) {
    super(message, { cause: details.cause });
    this.name = code === HlsDownloaderErrorCode.ABORTED ? 'AbortError' : 'HlsDownloaderError';
    this.code = code;
    this.url = sanitizeHlsUrl(details.url);
    this.status = details.status;
    this.segmentIndex = details.segmentIndex;
    this.attempt = details.attempt;
    this.adapter = details.adapter;
    this.recoverable = details.recoverable ?? false;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof HlsDownloaderError && error.code === HlsDownloaderErrorCode.ABORTED) ||
    (!!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
  );
}

export function normalizeHlsError(
  error: unknown,
  fallbackCode: HlsDownloaderErrorCode,
  details: HlsDownloaderErrorDetails = {},
): HlsDownloaderError {
  if (error instanceof HlsDownloaderError) return error;
  const aborted = isAbortError(error);
  const message = error instanceof Error ? error.message : String(error);
  return new HlsDownloaderError(
    aborted ? HlsDownloaderErrorCode.ABORTED : fallbackCode,
    aborted ? 'Operation aborted' : message,
    { ...details, cause: error },
  );
}
