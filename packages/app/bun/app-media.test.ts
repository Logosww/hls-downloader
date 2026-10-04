import { afterAll, beforeAll, expect, it } from 'bun:test';
import { HlsDownloader } from '@hls-downloader/core';
import { NodeAdapter } from '@hls-downloader/adapters/node';
import { TaskManager } from './task-manager';
import { createApp } from './app';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'bun-app-media-'));
const media = resolve(import.meta.dirname, '../../../test/fixtures/media');
let server: ReturnType<typeof Bun.serve>;
let manager: TaskManager;
beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.headers.get('authorization') !== 'Bearer fixture')
        return new Response(null, { status: 403 });
      if (path === '/master.m3u8')
        return new Response(
          '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/media.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a",SUBTITLES="s"\nvideo/media.m3u8\n',
        );
      if (path === '/sub.m3u8')
        return new Response(
          '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsub.vtt\n#EXT-X-ENDLIST\n',
        );
      if (path === '/sub.vtt')
        return new Response(
          'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n\n00:00:00.500 --> 00:00:01.000\nHello\n',
        );
      return new Response(
        Bun.file(
          join(media, path.startsWith('/audio/') ? 'audio-ts' : 'ts', path.split('/').at(-1)!),
        ),
      );
    },
  });
  const downloader = new HlsDownloader({
    adapter: NodeAdapter,
    onEvent: (event, payload) => manager.handleLibraryEvent(event, payload),
  });
  manager = new TaskManager(downloader, { outputDirectory: dir });
});
afterAll(() => {
  manager.dispose();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

it('streams selected audio through the real Bun/N-API writable bridge and exports aligned subtitles', async () => {
  const app = createApp(manager);
  const input = {
    url: `http://127.0.0.1:${server.port}/master.m3u8`,
    headers: { Authorization: 'Bearer fixture' },
    audio: { language: 'EN' },
  };
  const post = (path: string, body: unknown) =>
    app.handle(
      new Request('http://test' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const created = await post('/download', { ...input, stream: true });
  const id = (await created.json()).data.id;
  const response = await app.handle(new Request(`http://test/downloads/${id}/stream`));
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const file = manager.getFilePath(id)!;
  expect(readFileSync(file)).toEqual(bytes);
  for (let i = 0; i < 100 && manager.get(id)?.status !== 'completed'; i++) await Bun.sleep(5);
  expect(manager.get(id)?.status).toBe('completed');
  expect(manager.get(id)?.totalSegments).toBe(6);
  const pcm = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-f',
    'f32le',
    '-ac',
    '1',
    '-ar',
    '48000',
    'pipe:1',
  ]);
  const samples = new Float32Array(
    pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
  );
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1]! <= 0 && samples[i]! > 0) crossings++;
  expect(crossings / (samples.length / 48000)).toBeGreaterThan(800);
  const subtitles = await post('/subtitles', {
    ...input,
    subtitle: { groupId: 's', name: 'English' },
  });
  expect(subtitles.status).toBe(200);
  expect((await subtitles.json()).data.text).toContain('00:00:00.500 --> 00:00:01.000');
}, 20000);
