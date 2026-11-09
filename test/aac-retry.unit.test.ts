import { describe, expect, it, vi } from 'vitest';
import { withAacOverlapRetry } from '../packages/adapters/src/aac-retry';
import { validateAacOverlapRepair } from '../packages/adapters/src/timeline';
import { HlsDownloaderError, HlsDownloaderErrorCode as Code } from '../packages/shared/src/index';
import type { RecordingBridgeFactory } from '../packages/adapters/src/recording';
const overlap = () =>
  new HlsDownloaderError(Code.TIMELINE_FAILED, 'overlap', {
    reason: 'AacTimestampOverlap',
    aacOverlap: {
      slot: { inputId: 'primary', generation: '0', epoch: '0', sequence: '1' },
      original: { ticks: '0', timescale: 1 },
      expected: { ticks: '1', timescale: 100 },
      overlap: { ticks: '1', timescale: 100 },
    },
  });
const wire = JSON.stringify({ recording: { timeline: {} }, bootstrap: {}, identity: {} });
const readRequest = JSON.stringify({ requestId: '1', url: 'https://media/segment', maxBytes: '8' });
describe('AAC automatic retry boundaries', () => {
  it('uses Strict first, retries once with copied cached bytes and the configured limit', async () => {
    const policies: unknown[] = [],
      reads = vi.fn(async () => Uint8Array.of(1, 2));
    const factory: RecordingBridgeFactory = async (request, read) => {
      policies.push(JSON.parse(request).recording.timeline.aacTimestampPolicy);
      const bytes = await read(readRequest);
      expect([...bytes]).toEqual([1, 2]);
      bytes[0] = 99;
      return { run: async () => '', command: async () => '', dispose() {} };
    };
    let attempts = 0;
    await withAacOverlapRetry(factory, { maxShiftMs: 80 }, undefined, async (f) => {
      await f(
        wire,
        reads,
        async () => {},
        async () => ({ status: 'unavailable', key: new Uint8Array() }),
        () => {},
        async () => '',
      );
      if (++attempts === 1) throw overlap();
    });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(policies).toEqual([undefined, { mode: 'repair-overlaps', maxShiftMs: 80 }]);
  });
  it('never loops when repair also fails', async () => {
    const run = vi.fn(async () => {
      throw overlap();
    });
    await expect(
      withAacOverlapRetry(vi.fn() as any, undefined, undefined, run),
    ).rejects.toMatchObject({ reason: 'AacTimestampOverlap' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.each(['TimelineAmbiguous', 'AacTimestampRepairLimitExceeded'])(
    'does not retry %s',
    async (reason) => {
      const run = vi.fn(async () => {
        throw new HlsDownloaderError(Code.TIMELINE_FAILED, reason, { reason });
      });
      await expect(
        withAacOverlapRetry(vi.fn() as any, undefined, undefined, run),
      ).rejects.toMatchObject({ reason });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
  it('does not restart after cancellation', async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      throw overlap();
    });
    await expect(
      withAacOverlapRetry(vi.fn() as any, undefined, controller.signal, run),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('never retries after exposing output', async () => {
    const factory: RecordingBridgeFactory = async (_request, _read, write) => {
      await write(Uint8Array.of(1), '0');
      return { run: async () => '', command: async () => '', dispose() {} };
    };
    const run = vi.fn(async (f: RecordingBridgeFactory) => {
      await f(
        wire,
        async () => new Uint8Array(),
        async () => {},
        async () => ({ status: 'unavailable', key: new Uint8Array() }),
        () => {},
        async () => '',
      );
      throw overlap();
    });
    await expect(withAacOverlapRetry(factory, undefined, undefined, run)).rejects.toMatchObject({
      reason: 'AacTimestampOverlap',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([0, -1, NaN, Infinity, 0.5, 18_446_744_073_710])(
    'rejects invalid limits: %s',
    (maxShiftMs) => {
      expect(() => validateAacOverlapRepair({ maxShiftMs })).toThrow();
    },
  );
});
