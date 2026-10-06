import { afterAll, beforeAll, expect, it } from 'bun:test';
import { HlsDownloader } from '@hls-downloader/core';
import { NodeAdapter } from '@hls-downloader/adapters/node';
import {
  startFixtureServer,
  sendBytes,
  type FixtureHandler,
} from '../../../test/fixtures/http-server.ts';
import {
  timelineCases,
  timelineRoutes,
  timelineOptions,
  sampleKey,
} from '../../../test/fixtures/timeline.ts';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { TaskManager } from './task-manager';
import { createApp } from './app';

const cases = [
  'range-False',
  'config-split',
  'sample-fmp4_avc_cenc',
  'sample-fmp4_hevc_cbcs',
  'sample-ts_avc_sample',
].map((name) => timelineCases.find((c) => c.name === name));
const dir = mkdtempSync(join(tmpdir(), 'bun-app-timeline-'));
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let manager: TaskManager;
beforeAll(async () => {
  const routes: Record<string, FixtureHandler> = Object.assign(
    {},
    ...cases.map((c, i) => timelineRoutes(c, `/cases/${i}`)),
  );
  cases.forEach((c, i) => {
    for (const snapshot of [c.request.primary, c.request.audio].filter(Boolean))
      routes[`/cases/${i}${new URL('key', snapshot.url).pathname}`] = (_, res) =>
        sendBytes(res, sampleKey);
  });
  server = await startFixtureServer(routes);
  const downloader = new HlsDownloader({
    adapter: NodeAdapter,
    onEvent: (event, payload) => manager.handleLibraryEvent(event, payload),
  });
  manager = new TaskManager(downloader, { outputDirectory: dir });
});
afterAll(async () => {
  manager?.dispose();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});
const post = (path: string, body: unknown) =>
  createApp(manager).handle(
    new Request('http://test' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

it.each(cases)(
  'downloads real timeline media with report and independent files: $name',
  async (c) => {
    const index = cases.indexOf(c);
    const response = await post('/download', {
      url: `${server.origin}/cases/${index}/master.m3u8`,
      filename: c.name,
      timeline: timelineOptions(c).timeline,
    });
    expect(response.status).toBe(202);
    const id = (await response.json()).data.id;
    for (
      let count = 0;
      count < 1000 && ['queued', 'downloading'].includes(manager.get(id)!.status);
      count++
    )
      await Bun.sleep(5);
    const task = manager.get(id)!;
    expect(task.status).toBe('completed');
    expect(task.outputs).toHaveLength(c.outputs);
    expect(task.timelineReport?.outputs).toHaveLength(c.outputs);
    expect(task.timelineReport?.requested).toEqual(c.selection.range);
    const app = createApp(manager);
    for (const output of task.outputs!) {
      const fileResponse = await app.handle(
        new Request(`http://test/downloads/${id}/files/${output.index}`),
      );
      expect(fileResponse.status).toBe(200);
      expect((await fileResponse.arrayBuffer()).byteLength).toBeGreaterThan(100);
      const path = manager.getFilePath(id, output.index)!;
      expect(path.startsWith(dir)).toBe(true);
      execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-']);
    }
    const report = await app.handle(new Request(`http://test/downloads/${id}/report`));
    expect((await report.json()).data).toEqual(task.timelineReport);
    const chapters = await post(`/downloads/${id}/chapters`, {
      chapters: [{ range: task.timelineReport!.actual, title: 'Whole presentation' }],
    });
    expect(chapters.status).toBe(200);
    const sidecars = (await chapters.json()).data;
    expect(sidecars).toHaveLength(c.outputs);
    expect(sidecars.every((value: { text: string }) => value.text.startsWith('WEBVTT'))).toBe(true);
  },
  20000,
);

it('streams a selected sample-encrypted range and exposes its completed report and file', async () => {
  const c = cases.find((c) => c.name === 'sample-fmp4_avc_cenc');
  const created = await post('/download', {
    url: `${server.origin}/cases/${cases.indexOf(c)}/master.m3u8`,
    stream: true,
    timeline: timelineOptions(c).timeline,
  });
  expect(created.status).toBe(202);
  const id = (await created.json()).data.id;
  const app = createApp(manager);
  const stream = await app.handle(new Request(`http://test/downloads/${id}/stream`));
  expect(stream.status).toBe(200);
  const bytes = new Uint8Array(await stream.arrayBuffer());
  for (let count = 0; count < 1000 && manager.get(id)?.status !== 'completed'; count++)
    await Bun.sleep(5);
  const task = manager.get(id)!;
  expect(task.status).toBe('completed');
  expect(task.timelineReport?.requested).toEqual(c.selection.range);
  expect(task.outputs).toHaveLength(1);
  const file = await app.handle(new Request(`http://test/downloads/${id}/files/0`));
  expect(file.status).toBe(200);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  execFileSync('ffmpeg', ['-v', 'error', '-i', manager.getFilePath(id, '0')!, '-f', 'null', '-']);
}, 20000);

it('serves the first real published file after the second publication fails', async () => {
  const id = randomUUID();
  const blockedOutput = resolve(`${id}.002.mp4`);
  mkdirSync(blockedOutput);
  const partialManager = new TaskManager(new HlsDownloader({ adapter: NodeAdapter }), {
    createId: () => id,
    outputDirectory: dir,
  });
  try {
    const c = cases.find((c) => c.name === 'config-split');
    partialManager.create({
      url: `${server.origin}/cases/${cases.indexOf(c)}/master.m3u8`,
      timeline: { changePolicy: 'split' },
    });
    for (let count = 0; count < 1000 && partialManager.get(id)?.status === 'downloading'; count++)
      await Bun.sleep(5);
    const task = partialManager.get(id)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('OUTPUT_WRITE_FAILED');
    expect(task.outputs?.map((output) => output.index)).toEqual(['0']);
    const app = createApp(partialManager);
    const first = await app.handle(new Request(`http://test/downloads/${id}/files/0`));
    expect(first.status).toBe(200);
    expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await app.handle(new Request(`http://test/downloads/${id}/files/1`))).status).toBe(404);
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      partialManager.getFilePath(id, '0')!,
      '-f',
      'null',
      '-',
    ]);
  } finally {
    partialManager.dispose();
    rmSync(blockedOutput, { recursive: true, force: true });
  }
}, 20000);
