import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type HlsAacOverlapRepair,
} from '@hls-downloader/shared';
import type { RecordingBridgeFactory } from './recording';
import { assertActive } from './browser/request';

/** Operation-local ciphertext/resource cache; never persists keys or failed reads. */
export async function withAacOverlapRetry<T>(
  factory: RecordingBridgeFactory,
  options: Exclude<HlsAacOverlapRepair, false> | undefined,
  signal: AbortSignal | undefined,
  run: (factory: RecordingBridgeFactory) => Promise<T>,
): Promise<T> {
  const cache = new Map<string, Uint8Array>();
  const budget = options?.maxCacheBytes ?? 256 * 1024 * 1024;
  let size = 0;
  let complete = true;
  let retry = false;
  let exposed = false;
  let identity: string | undefined;
  const check = () => {
    if (signal) assertActive(signal);
  };
  const wrapped: RecordingBridgeFactory = async (request, read, write, resolve, abort, control) => {
    check();
    const wire = JSON.parse(request);
    const current = JSON.stringify([wire.bootstrap, wire.multitrack, wire.identity]);
    if (identity !== undefined && identity !== current)
      throw new HlsDownloaderError(
        Code.RESOURCE_CHANGED,
        'Selected input changed before AAC retry',
      );
    identity = current;
    if (retry)
      wire.recording.timeline.aacTimestampPolicy = {
        mode: 'repair-overlaps',
        maxShiftMs: options?.maxShiftMs ?? 50,
      };
    return factory(
      JSON.stringify(wire),
      async (text) => {
        check();
        const r = JSON.parse(text);
        const key = JSON.stringify([r.url, r.offset ?? null, r.length ?? null]);
        const saved = cache.get(key);
        if (saved) {
          if (saved.byteLength > Number(r.maxBytes))
            throw new HlsDownloaderError(
              Code.RESOURCE_LIMIT_EXCEEDED,
              'Cached resource exceeds read limit',
            );
          return saved.slice();
        }
        const bytes = await read(text);
        check();
        if (!retry && complete) {
          if (bytes.byteLength > budget - size) {
            complete = false;
            cache.clear();
            size = 0;
          } else {
            cache.set(key, bytes.slice());
            size += bytes.byteLength;
          }
        }
        return bytes;
      },
      async (bytes, index) => {
        exposed = true;
        await write(bytes, index);
      },
      resolve,
      abort,
      async (text) => {
        const r = JSON.parse(text);
        if ((r.action === 'event' && r.event?.type === 'output') || r.action === 'subtitleCommit')
          exposed = true;
        return control(text);
      },
    );
  };
  wrapped.inspectRecovery = factory.inspectRecovery;
  try {
    try {
      return await run(wrapped);
    } catch (error) {
      check();
      if (
        !complete ||
        exposed ||
        !(error instanceof HlsDownloaderError) ||
        error.code !== Code.TIMELINE_FAILED ||
        error.reason !== 'AacTimestampOverlap' ||
        !error.aacOverlap
      )
        throw error;
      retry = true;
      return await run(wrapped);
    }
  } finally {
    cache.clear();
  }
}
