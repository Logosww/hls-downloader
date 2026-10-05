import { describe, expect, it } from 'vitest';
import { readBoundedResource } from '../packages/adapters/src/bounded';
import { HlsDownloaderErrorCode as Code } from '../packages/shared/src/index';
const signal = () => new AbortController().signal;
describe('bounded keyed transport', () => {
  it('stops unknown-length bodies during reading', async () => {
    let cancelled = false;
    let reads = 0;
    const body = new ReadableStream({
      pull(c) {
        reads++;
        c.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBoundedResource(
        { url: 'https://example.test' },
        16,
        undefined,
        3,
        signal(),
        Code.SEGMENT_FETCH_FAILED,
        { fetch: async () => new Response(body) },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThanOrEqual(4);
  });
  it('retains offsets above Number.MAX_SAFE_INTEGER and validates exact 206 responses', async () => {
    const offset = '9007199254740993';
    let range;
    const result = await readBoundedResource(
      { url: 'https://example.test', offset, length: '3' },
      4,
      undefined,
      1,
      signal(),
      Code.SEGMENT_FETCH_FAILED,
      {
        fetch: async (_, init) => {
          range = new Headers(init.headers).get('range');
          return new Response(new Uint8Array(3), {
            status: 206,
            headers: { 'content-range': 'bytes 9007199254740993-9007199254740995/*' },
          });
        },
      },
    );
    expect(range).toBe('bytes=9007199254740993-9007199254740995');
    expect(result.bytes).toHaveLength(3);
  });
  it.each([200, 206])('rejects mismatched range status %s without retry', async (status) => {
    let requests = 0;
    await expect(
      readBoundedResource(
        { url: 'https://example.test', offset: '5', length: '3' },
        4,
        undefined,
        3,
        signal(),
        Code.SEGMENT_FETCH_FAILED,
        {
          fetch: async () => {
            requests++;
            return new Response(new Uint8Array(3), {
              status,
              headers: { 'content-range': 'bytes 0-2/10' },
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'SEGMENT_FETCH_FAILED' });
    expect(requests).toBe(1);
  });
  it('oversized key is invalid and never retried', async () => {
    let requests = 0;
    await expect(
      readBoundedResource(
        { url: 'https://example.test/key' },
        17,
        undefined,
        3,
        signal(),
        Code.KEY_RESOLUTION_FAILED,
        {
          fetch: async () => {
            requests++;
            return new Response(new Uint8Array(18));
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'KEY_INVALID' });
    expect(requests).toBe(1);
  });
  it('does not wait for a noncooperative body cancellation after exceeding the cap', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    await expect(
      readBoundedResource(
        { url: 'https://example.test' },
        16,
        undefined,
        1,
        signal(),
        Code.SEGMENT_FETCH_FAILED,
        { fetch: async () => new Response(body) },
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT_EXCEEDED' });
    expect(cancelled).toBe(true);
  }, 1000);
});
