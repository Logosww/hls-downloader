/** All protocol-sized integers are decimal strings, including values above 2^53. */
export interface HlsKeyRequest {
  operationId: string;
  inputId: string;
  resourceKind: 'media' | 'map';
  uri: string;
  method: 'AES-128' | 'SAMPLE-AES' | 'SAMPLE-AES-CTR';
  kid?: string;
  keyFormat: string;
  keyFormatVersions: readonly number[];
  originalSequence: string;
  epoch: string;
  generation: string;
  declaration: { revision: string; ordinal: string };
  resolveRevision: string;
  refreshGeneration: string;
  refreshReason: string;
  signal: AbortSignal;
}
export type HlsKeyResolver = (request: HlsKeyRequest) => Promise<{
  key: Uint8Array;
  version?: string;
  /** Relative lifetime from resolver completion; zero expires immediately. */
  expiresInMs?: number;
} | null>;
export interface HlsDecryptionOptions {
  /** Replaces the default identity HTTP provider. Only null permits candidate fallback. */
  keyResolver?: HlsKeyResolver;
  keyFormats?: readonly { format: string; versions: readonly number[] }[];
  /** complete-resources attests each range is independently encrypted and padded. */
  encryptedRanges?: 'reject' | 'complete-resources';
  limits?: {
    manifestBytes?: number;
    samples?: number;
    resourceBytes?: number;
    waitingBytes?: number;
    resources?: number;
    keyRequests?: number;
    cachedKeys?: number;
    keyWaiters?: number;
  };
}
export interface HlsResourceProgress {
  downloadedResources: string;
  downloadedBytes: string;
  decryptedResources: string;
  decryptedBytes: string;
  readyResources: string;
  clearBytes: string;
  cacheReuses: string;
}
export interface HlsDecryptionProgress {
  phase: string;
  bytesWritten: string;
  inputs: {
    inputId: string;
    generation: string;
    discovered: string;
    committed: string;
    media: HlsResourceProgress;
    maps: HlsResourceProgress;
  }[];
}
export interface HlsMediaKey {
  method: string;
  uri: string;
  keyFormat: string;
  keyFormatVersions: number[];
  iv: string | null;
  declaration: { revision: string; ordinal: string };
}
export interface HlsMediaResource {
  uri: string;
  range: { offset: string; length: string } | null;
  keys: HlsMediaKey[];
}
export interface HlsMediaPlaylist {
  version: 1;
  url: string;
  inputId: string;
  generation: string;
  revision: string;
  hlsVersion: string | null;
  targetDuration: string | null;
  playlistType: string | null;
  independentSegments: boolean;
  iframeOnly: boolean;
  retainedTags: string[];
  mediaSequence: string;
  discontinuitySequence: string;
  endList: boolean;
  segments: (HlsMediaResource & {
    originalSequence: string;
    epoch: string;
    duration: { ticks: string; timescale: number };
    map: HlsMediaResource | null;
    gap: boolean;
    discontinuity: boolean;
    programDateTime: string | null;
  })[];
}
