import { expect, it, vi, beforeEach, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({ light: vi.fn(), native: vi.fn(), init: vi.fn() }));
vi.mock('../packages/adapters/src/node/poster', () => ({
  extractPosterFromBytes: mocks.light,
}));
vi.mock('../packages/adapters/src/node/native.js', () => ({
  // Fast tests run before the generated native loader exists.
  cancelJob: vi.fn(),
  createCancelToken: vi.fn(),
  transcodeFileNative: vi.fn(),
  inspectRecoveryNative: vi.fn(),
  queryCapabilityNative: vi.fn(),
  continuousCreate: vi.fn(),
  continuousCommand: vi.fn(),
  continuousRun: vi.fn(),
  parseMediaPlaylistNative: vi.fn(),
  downloadAndMerge: vi.fn(),
  extractPosterBytes: mocks.native,
  initFfmpeg: mocks.init,
  parseHlsBytes: vi.fn(async () => ({
    resultType: 'segment',
    segments: [{ uri: 'https://example.test/segment.ts', duration: 1 }],
  })),
}));
import { NodeAdapter } from '../packages/adapters/src/node';
import { HlsDownloader } from '../packages/core/src';
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('fixture')),
  );
});
it('returns lightweight poster without native initialization', async () => {
  mocks.light.mockResolvedValue('data:image/jpeg;base64,bGlnaHQ=');
  const downloader = new HlsDownloader({ adapter: NodeAdapter });
  expect(await downloader.getPosterUrl({ url: 'https://example.test/light.m3u8' })).toContain(
    'bGlnaHQ=',
  );
  expect(mocks.native).not.toHaveBeenCalled();
  expect(mocks.init).not.toHaveBeenCalled();
});
it('falls back to native poster when lightweight extraction fails', async () => {
  mocks.light.mockResolvedValue(undefined);
  mocks.native.mockResolvedValue('data:image/jpeg;base64,bmF0aXZl');
  const downloader = new HlsDownloader({ adapter: NodeAdapter });
  expect(await downloader.getPosterUrl({ url: 'https://example.test/fallback.m3u8' })).toContain(
    'bmF0aXZl',
  );
  expect(mocks.native).toHaveBeenCalledOnce();
  expect(mocks.init).toHaveBeenCalledOnce();
});

it('accepts an exact-limit poster and gives both decoders the same bytes', async () => {
  const bytes = new Uint8Array(16 * 1024 * 1024);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(url.endsWith('.ts') ? bytes : 'fixture')),
  );
  mocks.light.mockResolvedValue(undefined);
  mocks.native.mockResolvedValue('data:image/jpeg;base64,AA==');
  await new HlsDownloader({ adapter: NodeAdapter }).getPosterUrl({
    url: 'https://example.test/exact.m3u8',
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(mocks.light.mock.calls[0]![0].byteLength).toBe(bytes.byteLength);
  expect(mocks.native.mock.calls[0]![0].buffer).toBe(mocks.light.mock.calls[0]![0].buffer);
});

it('cancels during decoding without starting the fallback or caching a late result', async () => {
  const started = Promise.withResolvers<void>();
  const decoded = Promise.withResolvers<string>();
  mocks.light.mockImplementationOnce(() => {
    started.resolve();
    return decoded.promise;
  });
  const controller = new AbortController();
  const d = new HlsDownloader({ adapter: NodeAdapter });
  const url = 'https://example.test/cancel.m3u8';
  const pending = d.getPosterUrl({ url, signal: controller.signal });
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  decoded.resolve('old');
  mocks.light.mockResolvedValueOnce('new');
  expect(await d.getPosterUrl({ url })).toBe('new');
  expect(mocks.native).not.toHaveBeenCalled();
});
