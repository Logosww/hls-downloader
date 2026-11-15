import { expect, it, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ light: vi.fn(), native: vi.fn(), init: vi.fn() }));
vi.mock('../packages/adapters/src/node/poster', () => ({
  extractPosterFromSegmentUrl: mocks.light,
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
  extractPoster: mocks.native,
  initFfmpeg: mocks.init,
  parseHlsNative: vi.fn(async () => ({
    resultType: 'segment',
    segments: [{ uri: 'https://example.test/segment.ts', duration: 1 }],
  })),
}));
import { NodeAdapter } from '../packages/adapters/src/node';
import { HlsDownloader } from '../packages/core/src';
beforeEach(() => {
  vi.clearAllMocks();
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
