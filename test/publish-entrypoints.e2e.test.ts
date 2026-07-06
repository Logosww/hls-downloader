import { describe, expect, it } from 'vitest';

describe.runIf(process.env.HLS_DOWNLOADER_TEST_PUBLISH_ENTRYPOINTS === '1')(
  'publish entrypoints e2e',
  () => {
    it('loads the root package entrypoint from dist', async () => {
      const entry = await import('../dist/index.js');

      expect(entry.default).toBe(entry.HlsDownloader);
      expect(entry.HlsDownloader).toBeTypeOf('function');
      expect(entry.HlsDownloaderEvent.READY_FOR_DOWNLOAD).toBe('ready-for-download');
      expect(entry.createAdapter).toBeTypeOf('function');
      expect(entry.NodeAdapter).toBeDefined();
      expect(entry.BrowserAdapter).toBeDefined();
    });

    it('loads every exported subpath used by package.json', async () => {
      const core = await import('../dist/core.js');
      const shared = await import('../dist/shared.js');
      const adaptersBrowser = await import('../dist/adapters-browser.js');
      const adaptersNode = await import('../dist/adapters-node.js');

      expect(core.default).toBe(core.HlsDownloader);
      expect(shared.createAdapter).toBeTypeOf('function');
      expect(shared.buildFfmpegOutputArgs({ preset: 'h264' })).toContain('libx264');
      expect(adaptersBrowser.BrowserAdapter).toBeDefined();
      expect(adaptersNode.NodeAdapter).toBeDefined();
    });

    it('loads workspace package entrypoints that are published together', async () => {
      const core = await import('@hls-downloader/core');
      const shared = await import('@hls-downloader/shared');
      const adapters = await import('@hls-downloader/adapters');
      const adaptersBrowser = await import('@hls-downloader/adapters/browser');
      const adaptersNode = await import('@hls-downloader/adapters/node');

      expect(core.default).toBe(core.HlsDownloader);
      expect(shared.HlsDownloaderEvent.ERROR).toBe('error');
      expect(adapters.BrowserAdapter).toBe(adaptersBrowser.BrowserAdapter);
      expect(adapters.NodeAdapter).toBe(adaptersNode.NodeAdapter);
    });
  },
);
