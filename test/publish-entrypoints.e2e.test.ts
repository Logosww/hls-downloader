import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

describe.runIf(process.env.HLS_DOWNLOADER_TEST_PUBLISH_ENTRYPOINTS === '1')(
  'publish entrypoints e2e',
  () => {
    it('type-checks the writable API from actual package tarballs', () => {
      const root = resolve(import.meta.dirname, '..');
      const dir = mkdtempSync(join(tmpdir(), 'hls-tarballs-'));
      try {
        for (const [source, name] of [
          ['.', '@logosw/hls-downloader'],
          ['packages/shared', '@hls-downloader/shared'],
          ['packages/core', '@hls-downloader/core'],
          ['packages/adapters', '@hls-downloader/adapters'],
        ]) {
          const [packed] = JSON.parse(
            execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], {
              cwd: resolve(root, source!),
              env: { ...process.env, npm_config_cache: join(dir, 'npm-cache') },
              encoding: 'utf8',
            }),
          );
          const destination = join(dir, 'node_modules', name!);
          mkdirSync(destination, { recursive: true });
          execFileSync('tar', [
            '-xzf',
            join(dir, packed.filename),
            '--strip-components=1',
            '-C',
            destination,
          ]);
        }
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
        writeFileSync(
          join(dir, 'consumer.ts'),
          `
          import { HlsDownloader, HlsDownloaderErrorCode, type HlsDownloaderWritableOptions } from '@logosw/hls-downloader';
          import { BrowserAdapter } from '@logosw/hls-downloader/adapters/browser';
          const downloader = new HlsDownloader({ adapter: BrowserAdapter });
          const options: HlsDownloaderWritableOptions = { url: 'https://example.test/media.m3u8', operationId: 'typed' };
          const capable: boolean | undefined = downloader.capabilities.writableOutput;
          const result: Promise<{ operationId: string; totalSegments: number }> = downloader.downloadToWritable(options, new WritableStream<Uint8Array>());
          const error: 'OUTPUT_WRITE_FAILED' = HlsDownloaderErrorCode.OUTPUT_WRITE_FAILED;
          // @ts-expect-error writable output never accepts transcoding
          downloader.downloadToWritable({ ...options, transcode: { preset: 'h264' } }, new WritableStream<Uint8Array>());
        `,
        );
        execFileSync(
          resolve(root, 'node_modules/.bin/tsc'),
          [
            '--noEmit',
            '--strict',
            '--skipLibCheck',
            '--module',
            'NodeNext',
            '--target',
            'ES2022',
            '--lib',
            'ES2022,DOM',
            join(dir, 'consumer.ts'),
          ],
          { cwd: dir, encoding: 'utf8' },
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loads the root package entrypoint from dist', async () => {
      const entry = await import('../dist/index.js');

      expect(entry.default).toBe(entry.HlsDownloader);
      expect(entry.HlsDownloader).toBeTypeOf('function');
      expect(entry.HlsDownloaderEvent.READY_FOR_DOWNLOAD).toBe('ready-for-download');
      expect(entry.HlsDownloaderErrorCode.ABORTED).toBe('ABORTED');
      expect(entry.HlsDownloader.prototype.downloadToWritable).toBeTypeOf('function');
      expect(entry.HlsDownloaderErrorCode.OUTPUT_WRITE_FAILED).toBe('OUTPUT_WRITE_FAILED');
      expect(entry.HlsDownloaderErrorCode.UNSUPPORTED_OUTPUT).toBe('UNSUPPORTED_OUTPUT');
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
      expect(shared.HlsDownloaderError).toBeTypeOf('function');
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
      expect(
        new core.HlsDownloader({ adapter: adaptersBrowser.BrowserAdapter }).capabilities,
      ).toMatchObject({
        configurableRetry: true,
        persistentOutput: false,
        writableOutput: true,
      });
    });
  },
);
