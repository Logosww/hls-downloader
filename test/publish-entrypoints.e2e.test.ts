import { describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { encryptedRoutes } from './fixtures/encrypted';
import { timelineCases, timelineRoutes } from './fixtures/timeline';
import { startFixtureServer } from './fixtures/http-server';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

describe.runIf(process.env.HLS_DOWNLOADER_TEST_PUBLISH_ENTRYPOINTS === '1')(
  'publish entrypoints e2e',
  () => {
    it('type-checks public APIs and decodes AES outputs from isolated package tarballs', async () => {
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
          import { HlsDownloader, HlsDownloaderErrorCode, exportChapters, type HlsDownloaderWritableOptions } from '@logosw/hls-downloader';
          import { BrowserAdapter, type HlsDownloaderBrowserRequestOptions } from '@logosw/hls-downloader/adapters/browser';
          import { NodeAdapter, type NodeAdapterResumeOptions } from '@logosw/hls-downloader/adapters/node';
          import type { NodeAdapterResumeOptions as RootResume } from '@logosw/hls-downloader';
          import type { NodeAdapterResumeOptions as SubpackageResume } from '@hls-downloader/adapters/node';
          const resume: NodeAdapterResumeOptions & RootResume & SubpackageResume = { directory: './job' };
          const node = new HlsDownloader({ adapter: NodeAdapter });
          node.download({ url: 'https://example.test/media.m3u8', resume });
          node.downloadToWritable({url:'https://example.test/master.m3u8', audio:{language:'en'}}, new WritableStream<Uint8Array>());
          const subtitles: Promise<import('@logosw/hls-downloader').HlsDownloaderSubtitleResult> = node.downloadSubtitles({url:'https://example.test/master.m3u8',subtitle:{groupId:'s',name:'en'}});
          const selection: import('@logosw/hls-downloader/shared').AudioSelection = {groupId:'a',name:'en'};
          // @ts-expect-error subtitle selection is required
          node.downloadSubtitles({url:'https://example.test/master.m3u8'});
          const resolver: import('@logosw/hls-downloader').HlsKeyResolver = async request => { const sequence: string = request.originalSequence; return { key: new Uint8Array(16), expiresInMs: 500 }; };
          node.download({url:'https://example.test/a.m3u8',decryption:{keyResolver:resolver}});
          const typedPlaylist: Promise<import('@logosw/hls-downloader/shared').HlsMediaPlaylist> = node.parseMediaPlaylist('#EXTM3U','https://example.test/a.m3u8');
          node.downloadOutputs({url:'https://example.test/a.m3u8',timeline:{changePolicy:'split'}}).then(r => {
            exportChapters({timelineReport:r.timelineReport,chapters:[]});
            node.downloadSubtitleOutputs({url:'https://example.test/a.m3u8',subtitle:{groupId:'s',name:'en'},timelineReport:r.timelineReport});
          });
          const recording = node.startRecording({url:'https://example.test/live.m3u8',output:{type:'file',path:'capture.mp4'}});
          recording.result.then(r => { const path: string = r.filePath; const count: string = r.report.bytesWritten; });
          recording.restartInput('primary',{generation:'9007199254740993'});
          const recordingError: 'RECORDING_FAILED' = HlsDownloaderErrorCode.RECORDING_FAILED;
          const multi = node.downloadMultiTrack({url:'https://example.test/master.m3u8',embeddedAudio:'keep',output:{type:'file',path:'multi.mp4'}});
          multi.then(r => { const report: import('@logosw/hls-downloader/shared').HlsMultiTrackReport = r.report; const path: string = r.filePath; });
          const multiSession = node.startMultiTrackRecording({url:'https://example.test/master.m3u8',embeddedAudio:'exclude',audioTracks:[{id:'en',selector:{language:'en'}}],output:{type:'writable',writable:new WritableStream<Uint8Array>()}});
          multiSession.restartInput('en',{generation:'9007199254740993'});
          const multiError: 'MULTITRACK_FAILED' = HlsDownloaderErrorCode.MULTITRACK_FAILED;
          // @ts-expect-error embedded audio policy is required
          node.downloadMultiTrack({url:'https://example.test/media.m3u8',output:{type:'file',path:'multi.mp4'}});

          node.downloadToWritables({url:'https://example.test/a.m3u8'}, async output => new WritableStream<Uint8Array>());
          // @ts-expect-error split is only accepted by multiple-output entrypoints
          node.download({url:'https://example.test/a.m3u8',timeline:{changePolicy:'split'}});
          const decryptionError: 'KEY_INVALID' = HlsDownloaderErrorCode.KEY_INVALID;
          // @ts-expect-error key bytes must be binary
          const badResolver: import('@logosw/hls-downloader').HlsKeyResolver = async () => ({ key: 'secret' });
          const recoveryCapable: boolean | undefined = node.capabilities.resumableDownload;
          const recoveryError: 'RESUME_INVALID' = HlsDownloaderErrorCode.RESUME_INVALID;
          // @ts-expect-error recovery is not a global option
          new HlsDownloader({ adapter: NodeAdapter, options: { resume } });
          const downloader = new HlsDownloader({ adapter: BrowserAdapter });
          // @ts-expect-error recovery is Node-only
          downloader.download({ url: 'https://example.test/media.m3u8', resume });
          const browserRequest: HlsDownloaderBrowserRequestOptions = { fetch: async (url, init) => fetch(url, init), credentials: 'include' };
          const configured = new HlsDownloader({ adapter: BrowserAdapter, options: { browserRequest } });
          const request = { url: 'https://example.test/list.m3u8', browserRequest };
          configured.parseHls(request);
          configured.getPosterUrl(request);
          configured.download(request);
          configured.downloadToStream(request, () => {});
          configured.downloadToWritable(request, new WritableStream<Uint8Array>());
          // @ts-expect-error browser transport is not a Node option
          new HlsDownloader({ adapter: NodeAdapter, options: { browserRequest } });
          // @ts-expect-error browser transport is not a Node operation option
          node.parseHls({ url: request.url, browserRequest });
          // @ts-expect-error browser transport is not a Node download option
          node.download({ url: request.url, browserRequest });
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
        // A separate Node process prevents workspace aliases or source imports from
        // hiding missing public exports, native bindings or packaged WASM assets.
        writeFileSync(
          join(dir, 'consumer.mjs'),
          `
          import { HlsDownloader, BrowserAdapter, NodeAdapter, exportChapters } from '@logosw/hls-downloader';
          import { readFileSync, writeFileSync } from 'node:fs';
          import assert from 'node:assert/strict';
          const realFetch = globalThis.fetch;
          globalThis.fetch = (url, init) => String(url).startsWith('file:') && String(url).endsWith('.wasm')
            ? Promise.resolve(new Response(readFileSync(new URL(url)), {headers:{'content-type':'application/wasm'}}))
            : realFetch(url, init);
          for (const [name, adapter] of [['browser', BrowserAdapter], ['node', NodeAdapter]]) {
            const d = new HlsDownloader({adapter});
            assert.equal(d.capabilities.aes128, true);
            assert.equal(d.capabilities.liveRecording, true);
            const multiChunks=[]; let multiClosed=false;
            const multi = await d.downloadMultiTrack({url:process.argv[2]+'/master.m3u8',embeddedAudio:'keep',output:{type:'writable',writable:new WritableStream({write(b){multiChunks.push(b);},close(){multiClosed=true;}})}});
            assert.equal(multiClosed,true); assert.ok(multi.report.tracks.length>0); assert.ok(d.capabilities.multiTrack);
            writeFileSync(name+'-multitrack.mp4',Buffer.concat(multiChunks));
            const recordingChunks = []; let recordingClosed = false;
            const recording = d.startRecording({url:process.argv[2]+'/master.m3u8',output:{type:'writable',writable:new WritableStream({write(b){recordingChunks.push(b);},close(){recordingClosed=true;}})}});
            const recorded = await recording.result;
            assert.equal(recorded.report.endReason,'Eof'); assert.equal(recordingClosed,true);
            writeFileSync(name+'-recording.mp4',Buffer.concat(recordingChunks));
            assert.equal(d.capabilities.decryption.resume, false);
            const text = await (await fetch(process.argv[2] + '/video/media.m3u8')).text();
            const metadata = await d.parseMediaPlaylist(text, process.argv[2] + '/video/media.m3u8');
            assert.equal(metadata.mediaSequence, '9007199254740993');
            for (const mode of ['download', 'stream', 'writable']) {
              const options = {url:process.argv[2] + '/master.m3u8', filename:name+'-'+mode+'.mp4'};
              let bytes;
              if (mode === 'download') {
                const output = await d.download(options);
                if ('blobURL' in output) {
                  bytes = new Uint8Array(await (await fetch(output.blobURL)).arrayBuffer());
                  URL.revokeObjectURL(output.blobURL);
                } else bytes = readFileSync(output.filePath);
              } else {
                const chunks = [];
                if (mode === 'stream') await d.downloadToStream(options, b => {chunks.push(b);});
                else await d.downloadToWritable(options, new WritableStream({write(b){chunks.push(b);}}));
                bytes = Buffer.concat(chunks);
              }
              writeFileSync(options.filename, bytes);
            }
            assert.equal(d.capabilities.timeline.split, true);
            for (const [fixture, expected] of [['config-split', 2], ['sample-fmp4_avc_cenc', 1]]) {
              const options = {url:process.argv[3]+'/'+fixture+'/master.m3u8', filename:name+'-'+fixture,
                timeline:{changePolicy:'split'},decryption:{keyResolver:async () => ({key:Uint8Array.from(Buffer.from('2b7e151628aed2a6abf7158809cf4f3c','hex'))})}};
              const result = await d.downloadOutputs(options);
              assert.equal(result.outputs.length, expected);
              assert.equal(result.timelineReport.schemaVersion, 1);
              assert.equal(exportChapters({timelineReport:result.timelineReport,chapters:[{title:'Test',range:result.timelineReport.actual}]}).length, expected);
              for (const o of result.outputs) {
                const bytes = 'blobURL' in o ? new Uint8Array(await (await fetch(o.blobURL)).arrayBuffer()) : readFileSync(o.filePath);
                if ('blobURL' in o) URL.revokeObjectURL(o.blobURL);
                writeFileSync(name+'-'+fixture+'-'+o.index+'.mp4',bytes);
              }
              let closed = 0;
              const streamed = await d.downloadToWritables(options,async () => new WritableStream({close(){closed++;}}));
              assert.equal(closed,expected);
              assert.equal(streamed.timelineReport.outputs.length,expected);
            }
          }
        `,
        );
        const server = await startFixtureServer(encryptedRoutes('ts', true, true, false));
        const m2Cases = timelineCases.filter((c) =>
          ['config-split', 'sample-fmp4_avc_cenc'].includes(c.name),
        );
        const timelineServer = await startFixtureServer(
          Object.assign({}, ...m2Cases.map((c) => timelineRoutes(c, '/' + c.name))),
        );
        try {
          await promisify(execFile)(
            process.execPath,
            [join(dir, 'consumer.mjs'), server.origin, timelineServer.origin],
            {
              cwd: dir,
              timeout: 30000,
            },
          );
        } finally {
          await server.close();
          await timelineServer.close();
        }
        for (const name of ['browser', 'node'])
          for (const c of m2Cases)
            for (let i = 0; i < c.outputs; i++)
              execFileSync(
                'ffmpeg',
                [
                  '-v',
                  'error',
                  '-xerror',
                  '-i',
                  join(dir, name + '-' + c.name + '-' + i + '.mp4'),
                  '-f',
                  'null',
                  '-',
                ],
                { stdio: 'pipe' },
              );
        const hashes = (file: string) =>
          execFileSync(
            'ffmpeg',
            ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'],
            { encoding: 'utf8' },
          )
            .split('\n')
            .filter((l) => l && !l.startsWith('#'))
            .map((l) => l.split(',').at(-1)?.trim());
        const clear = hashes(resolve(root, 'test/fixtures/media/ts/media.m3u8'));
        for (const name of ['browser', 'node'])
          for (const mode of ['download', 'stream', 'writable', 'recording']) {
            const file = join(dir, name + '-' + mode + '.mp4');
            expect(hashes(file)).toEqual(clear);
            const probe = JSON.parse(
              execFileSync(
                'ffprobe',
                ['-v', 'error', '-show_packets', '-show_format', '-of', 'json', file],
                { encoding: 'utf8' },
              ),
            );
            const end = Math.max(
              ...probe.packets.map((p: any) => Number(p.pts_time) + Number(p.duration_time)),
            );
            expect(Math.abs(Number(probe.format.duration) - end)).toBeLessThan(0.05);
            expect(end).toBeGreaterThan(3.3);
          }
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
      expect(entry.HlsDownloader.prototype.startRecording).toBeTypeOf('function');
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
