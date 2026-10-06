import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  HlsDownloaderEvent as Event,
  emitAdapterEvent,
} from '@hls-downloader/shared';
import type {
  HlsDownloaderAdapterInternal,
  HlsKeyRequest,
  HlsMediaPlaylist,
  HlsDecryptionProgress,
} from '@hls-downloader/shared';
import { assertActive, cancellable } from './browser/request';
import { readBoundedResource } from './bounded';
import {
  checkPreparedReport,
  type SelectedMedia,
  type RequestOptions,
  type PreparedReport,
} from './renditions';

export const decryptionProfile = Object.freeze({
  methods: Object.freeze(['AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR'] as const),
  profiles: Object.freeze(
    [
      { method: 'AES-128', container: 'ts', scheme: 'cbc', codecs: ['avc', 'hevc', 'aac-lc'] },
      { method: 'AES-128', container: 'fmp4', scheme: 'cbc', codecs: ['avc', 'hevc', 'aac-lc'] },
      { method: 'SAMPLE-AES', container: 'ts', scheme: 'sample-cbc', codecs: ['avc', 'aac-lc'] },
      {
        method: 'SAMPLE-AES',
        container: 'fmp4',
        scheme: 'cbcs',
        codecs: ['avc', 'hevc', 'aac-lc'],
      },
      {
        method: 'SAMPLE-AES-CTR',
        container: 'fmp4',
        scheme: 'cenc',
        codecs: ['avc', 'hevc', 'aac-lc'],
      },
    ].map((p) => Object.freeze({ ...p, codecs: Object.freeze(p.codecs) })),
  ),
  containers: Object.freeze(['ts', 'fmp4'] as const),
  codecs: Object.freeze(['avc', 'hevc', 'aac-lc'] as const),
  finite: true as const,
  externalAudio: true as const,
  resume: false as const,
});
export type KeyReply = { status: string; key: Uint8Array; version?: string; ttl?: string };
export type KeyedEngine = (
  request: string,
  read: (request: string) => Promise<Uint8Array>,
  write: (bytes: Uint8Array, index?: string) => Promise<void>,
  resolve: (request: string) => Promise<KeyReply>,
  abort: (id: string) => void,
  progress: (event: string) => void,
  signal: AbortSignal,
  control?: import('@hls-downloader/shared').HlsOutputControl,
) => Promise<string>;
export function requiresKeyed(media: SelectedMedia, options: RequestOptions): boolean {
  return (
    options.timeline !== undefined ||
    options.decryption !== undefined ||
    [media.primary, media.audio].some((s) => s && /^\s*#EXT-X-KEY:/m.test(s.text))
  );
}
export function parseMediaMetadata(result: string): HlsMediaPlaylist {
  const value = JSON.parse(result);
  checkPreparedReport(value);
  return value as HlsMediaPlaylist;
}
const defaults = {
  samples: 65536,
  resourceBytes: 16 * 1024 * 1024,
  waitingBytes: 32 * 1024 * 1024,
  resources: 2,
  keyRequests: 2,
  cachedKeys: 8,
  keyWaiters: 2,
};
let nextScope = 0;
export async function executeKeyed(
  adapter: HlsDownloaderAdapterInternal,
  options: RequestOptions & { signal: AbortSignal },
  media: SelectedMedia,
  engine: KeyedEngine,
  mode: string,
  write: (bytes: Uint8Array, index?: string) => Promise<void>,
  output?: string,
  control?: import('@hls-downloader/shared').HlsOutputControl,
): Promise<PreparedReport> {
  if (options.transcode !== undefined)
    throw new HlsDownloaderError(Code.UNSUPPORTED_OUTPUT, 'Encrypted input cannot be transcoded');
  const limits = {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(options.decryption?.limits ?? {}).filter(([, value]) => value !== undefined),
    ),
  };
  if (
    options.decryption?.encryptedRanges !== undefined &&
    !['reject', 'complete-resources'].includes(options.decryption.encryptedRanges)
  )
    throw new HlsDownloaderError(Code.ENCRYPTION_INVALID, 'Invalid encrypted range policy');
  if (
    Object.values(limits).some((n) => !Number.isSafeInteger(n) || n <= 0) ||
    limits.waitingBytes < limits.resourceBytes
  )
    throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Invalid decryption limits');
  const formats = options.decryption?.keyFormats ?? [{ format: 'identity', versions: [1] }];
  if (
    formats.some(
      (f) =>
        !f.format ||
        !f.versions.length ||
        f.versions.some((v) => !Number.isInteger(v) || v <= 0 || v > 0xffffffff),
    )
  )
    throw new HlsDownloaderError(Code.KEY_INVALID, 'Invalid key format configuration');
  const scope = `keyed-${++nextScope}`;
  const controllers = new Map<string, AbortController>();
  let active = true;
  let originalError: unknown;
  const abort = (id: string) => {
    controllers.get(id)?.abort();
    controllers.delete(id);
  };
  const abortAll = () => {
    for (const id of controllers.keys()) abort(id);
  };
  options.signal.addEventListener('abort', abortAll, { once: true });
  const request = async <T>(
    id: string,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    assertActive(options.signal);
    if (!active) throw new HlsDownloaderError(Code.ABORTED, 'Operation ended');
    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      return await cancellable(action(controller.signal), controller.signal);
    } finally {
      controllers.delete(id);
    }
  };
  const snapshot = (s: SelectedMedia['primary']) => ({ url: s.url, text: s.text });
  try {
    const result = await engine(
      JSON.stringify({
        wireVersion: 3,
        timeline: options.timeline,
        primary: snapshot(media.primary),
        audio: media.audio && snapshot(media.audio),
        operationId: options.operationId ?? scope,
        scope,
        mode,
        output,
        limits,
        keyFormats: formats,
        encryptedRanges: options.decryption?.encryptedRanges ?? 'reject',
      }),
      async (value) => {
        const r = JSON.parse(value);
        try {
          return await request(
            r.requestId,
            async (signal) =>
              (
                await readBoundedResource(
                  r,
                  Number(r.maxBytes),
                  options.headers,
                  options.maxRetry ?? adapter.segmentRetryAttempts,
                  signal,
                  Code.SEGMENT_FETCH_FAILED,
                  options.browserRequest,
                )
              ).bytes,
          );
        } catch (error) {
          if (
            !options.signal.aborted &&
            error instanceof HlsDownloaderError &&
            error.code !== Code.ABORTED
          )
            originalError ??= error;
          throw error;
        }
      },
      async (bytes, index) => {
        assertActive(options.signal);
        if (!active) throw new HlsDownloaderError(Code.ABORTED, 'Operation ended');
        try {
          await cancellable(write(bytes, index), options.signal);
        } catch (error) {
          originalError ??= error;
          throw error;
        }
      },
      async (value) => {
        const { requestId, ...data } = JSON.parse(value);
        const empty = { key: new Uint8Array() };
        try {
          return await request(requestId, async (signal) => {
            let reply;
            if (options.decryption?.keyResolver) {
              try {
                reply = await cancellable(
                  Promise.resolve().then(() =>
                    options.decryption!.keyResolver!({
                      ...data,
                      kid: data.kid ?? undefined,
                      signal,
                    } as HlsKeyRequest),
                  ),
                  signal,
                );
              } catch {
                return { ...empty, status: 'failure' };
              }
            } else {
              if (data.keyFormat !== 'identity' || !data.keyFormatVersions.includes(1))
                return { ...empty, status: 'unavailable' };
              try {
                reply = {
                  key: (
                    await readBoundedResource(
                      { url: data.uri },
                      17,
                      options.headers,
                      options.maxRetry ?? adapter.segmentRetryAttempts,
                      signal,
                      Code.KEY_RESOLUTION_FAILED,
                      options.browserRequest,
                    )
                  ).bytes,
                };
              } catch (error) {
                return {
                  ...empty,
                  status:
                    error instanceof HlsDownloaderError && error.code === Code.KEY_INVALID
                      ? 'invalid'
                      : 'failure',
                };
              }
            }
            if (reply === null) return { ...empty, status: 'unavailable' };
            if (
              !reply ||
              !(reply.key instanceof Uint8Array) ||
              reply.key.byteLength !== 16 ||
              (reply.version !== undefined && typeof reply.version !== 'string') ||
              (reply.expiresInMs !== undefined &&
                (!Number.isSafeInteger(reply.expiresInMs) || reply.expiresInMs < 0))
            )
              return { ...empty, status: 'invalid' };
            assertActive(signal);
            return {
              status: 'available',
              key: new Uint8Array(reply.key),
              version: reply.version,
              ttl: reply.expiresInMs?.toString(),
            };
          });
        } catch {
          return { ...empty, status: 'failure' };
        }
      },
      abort,
      (event) => {
        if (!active || options.signal.aborted) return;
        const progress = JSON.parse(event) as HlsDecryptionProgress;
        emitAdapterEvent(adapter, options, Event.DECRYPTION_PROGRESS, { decryption: progress });
        const completed = progress.inputs.reduce((n, p) => n + BigInt(p.committed), 0n);
        const total = progress.inputs.reduce((n, p) => n + BigInt(p.discovered), 0n);
        if (
          completed <= BigInt(Number.MAX_SAFE_INTEGER) &&
          total <= BigInt(Number.MAX_SAFE_INTEGER)
        )
          emitAdapterEvent(adapter, options, Event.DOWNLOADING_SEGMENTS, {
            completed: Number(completed),
            total: Number(total),
          });
      },
      options.signal,
      control &&
        (async (request) => {
          if (active && mode.startsWith('file') && request.action === 'complete')
            return control(request);
          assertActive(options.signal);
          if (!active) throw new HlsDownloaderError(Code.ABORTED, 'Operation ended');
          try {
            return await cancellable(control(request), options.signal);
          } catch (error) {
            originalError ??= error;
            throw error;
          }
        }),
    );
    if (originalError) throw originalError;
    assertActive(options.signal);
    return checkPreparedReport(camelCaseReport(JSON.parse(result)));
  } catch (error) {
    throw originalError ?? error;
  } finally {
    active = false;
    abortAll();
    options.signal.removeEventListener('abort', abortAll);
  }
}

export function executeMedia(
  adapter: HlsDownloaderAdapterInternal,
  options: RequestOptions & { signal: AbortSignal },
  media: SelectedMedia,
  legacy: import('./prepared').Engine,
  keyed: KeyedEngine,
  mode: string,
  write: (bytes: Uint8Array, index?: string) => Promise<void>,
  output?: string,
  timeline?: KeyedEngine,
): Promise<PreparedReport> {
  if (options.timeline) {
    validateTimeline(options.timeline, false);
    if (!timeline)
      throw new HlsDownloaderError(Code.UNSUPPORTED_OUTPUT, 'Timeline engine unavailable');
    return executeKeyed(adapter, options, media, timeline, mode, write, output, async (r) =>
      r.action === 'acquire' ? (output ?? '') : '',
    );
  }
  return requiresKeyed(media, options)
    ? executeKeyed(adapter, options, media, keyed, mode, write, output)
    : executePrepared(adapter, options, media, legacy, mode, write, output);
}
import { executePrepared } from './prepared';

import { validateTimeline, camelCaseReport } from './timeline';
