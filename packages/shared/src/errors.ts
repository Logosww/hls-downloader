import type { HlsCompletedOutput } from './timeline';
export const HlsDownloaderErrorCode = {
  RANGE_INVALID: 'RANGE_INVALID',
  TIMELINE_FAILED: 'TIMELINE_FAILED',
  RESOURCE_CHANGED: 'RESOURCE_CHANGED',
  BRIDGE_VERSION_MISMATCH: 'BRIDGE_VERSION_MISMATCH',
  KEY_UNAVAILABLE: 'KEY_UNAVAILABLE',
  KEY_RESOLUTION_FAILED: 'KEY_RESOLUTION_FAILED',
  KEY_INVALID: 'KEY_INVALID',
  KEY_EXPIRED: 'KEY_EXPIRED',
  ENCRYPTION_INVALID: 'ENCRYPTION_INVALID',
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  MEDIA_INVALID: 'MEDIA_INVALID',
  RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
  RENDITION_NOT_FOUND: 'RENDITION_NOT_FOUND',
  UNSUPPORTED_RENDITION: 'UNSUPPORTED_RENDITION',
  SUBTITLE_INVALID: 'SUBTITLE_INVALID',
  RESUME_CONFLICT: 'RESUME_CONFLICT',
  RESUME_INVALID: 'RESUME_INVALID',
  RESUME_IO_FAILED: 'RESUME_IO_FAILED',
  MANIFEST_FETCH_FAILED: 'MANIFEST_FETCH_FAILED',
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  NO_VARIANT: 'NO_VARIANT',
  SEGMENT_FETCH_FAILED: 'SEGMENT_FETCH_FAILED',
  UNSUPPORTED_ENCRYPTION: 'UNSUPPORTED_ENCRYPTION',
  TRANSMUX_FAILED: 'TRANSMUX_FAILED',
  TRANSCODE_FAILED: 'TRANSCODE_FAILED',
  ABORTED: 'ABORTED',
  UNSUPPORTED_OUTPUT: 'UNSUPPORTED_OUTPUT',
  OUTPUT_WRITE_FAILED: 'OUTPUT_WRITE_FAILED',
} as const;

export type HlsDownloaderErrorCode =
  (typeof HlsDownloaderErrorCode)[keyof typeof HlsDownloaderErrorCode];

export type HlsDownloaderErrorDetails = {
  url?: string;
  status?: number;
  segmentIndex?: number;
  inputRole?: 'primary' | 'audio' | 'subtitles';
  phase?: string;
  reason?: string;
  inputId?: string;
  originalSequence?: string;
  epoch?: string;
  trackId?: number;
  sampleIndex?: string;
  scheme?: string;
  completedOutputs?: HlsCompletedOutput[];
  resourceKind?: 'media' | 'map';
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
  readonly inputRole?: 'primary' | 'audio' | 'subtitles';
  readonly phase?: string;
  readonly reason?: string;
  readonly inputId?: string;
  readonly originalSequence?: string;
  readonly epoch?: string;
  readonly trackId?: number;
  readonly sampleIndex?: string;
  readonly scheme?: string;
  readonly completedOutputs?: HlsCompletedOutput[];
  readonly resourceKind?: 'media' | 'map';
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
    this.inputRole = details.inputRole;
    this.phase = details.phase;
    this.reason = details.reason;
    this.inputId = details.inputId;
    this.originalSequence = details.originalSequence;
    this.epoch = details.epoch;
    this.resourceKind = details.resourceKind;
    this.trackId = details.trackId ?? undefined;
    this.sampleIndex = details.sampleIndex ?? undefined;
    this.scheme = details.scheme ?? undefined;
    this.completedOutputs = details.completedOutputs ?? undefined;

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
