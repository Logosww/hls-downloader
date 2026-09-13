import { afterEach, describe, expect, it } from 'bun:test';
import { HlsDownloaderEvent } from '@hls-downloader/shared';
import { createApp } from './app';
import { TaskManager, type DownloaderLike } from './task-manager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeDownloader() {
  const downloads: Array<ReturnType<typeof deferred<{ filePath: string; totalSegments: number }>>> =
    [];
  const calls: Array<{ operationId: string; signal: AbortSignal }> = [];
  const downloader: DownloaderLike = {
    async init() {},
    async getPosterUrl() {
      return undefined;
    },
    download(options) {
      const job = deferred<{ filePath: string; totalSegments: number }>();
      downloads.push(job);
      calls.push({ operationId: options.operationId, signal: options.signal });
      return job.promise;
    },
    async downloadToStream(options, onChunk) {
      calls.push({ operationId: options.operationId, signal: options.signal });
      onChunk(new Uint8Array([1, 2, 3]));
      await new Promise<void>((resolve, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
        setTimeout(resolve, 5);
      });
      return { totalSegments: 1 };
    },
  };
  return { downloader, downloads, calls };
}

const managers: TaskManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

describe('TaskManager', () => {
  it('limits concurrency and routes progress by operationId', async () => {
    const fake = fakeDownloader();
    let id = 0;
    const manager = new TaskManager(fake.downloader, {
      maxActiveTasks: 2,
      createId: () => `t${++id}`,
    });
    managers.push(manager);
    const first = manager.create({ url: 'https://test/1.m3u8' });
    const second = manager.create({ url: 'https://test/2.m3u8' });
    const third = manager.create({ url: 'https://test/3.m3u8' });
    await Promise.resolve();

    expect(manager.get(first.id)?.status).toBe('downloading');
    expect(manager.get(second.id)?.status).toBe('downloading');
    expect(manager.get(third.id)?.status).toBe('queued');
    manager.handleSdkEvent(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
      operationId: second.id,
      total: 10,
      completed: 4,
    });
    expect(manager.get(second.id)?.progress).toEqual({ total: 10, completed: 4 });
    expect(manager.get(first.id)?.progress).toBeUndefined();

    fake.downloads[0]!.resolve({ filePath: '/tmp/one.mp4', totalSegments: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.get(third.id)?.status).toBe('downloading');
  });

  it('cancels idempotently without changing other tasks', async () => {
    const fake = fakeDownloader();
    const removed: string[] = [];
    let id = 0;
    const manager = new TaskManager(fake.downloader, {
      createId: () => `c${++id}`,
      removeFile: async (path) => {
        removed.push(path);
      },
    });
    managers.push(manager);
    const first = manager.create({ url: 'https://test/1.m3u8' });
    const second = manager.create({ url: 'https://test/2.m3u8' });
    expect(manager.cancel(first.id).kind).toBe('ok');
    expect(manager.cancel(first.id).task?.status).toBe('cancelled');
    expect(fake.calls.find((call) => call.operationId === first.id)?.signal.aborted).toBe(true);
    expect(manager.get(second.id)?.status).toBe('downloading');
    fake.downloads[0]!.resolve({ filePath: '/tmp/late.mp4', totalSegments: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.get(first.id)?.status).toBe('cancelled');
    expect(removed).toEqual(['/tmp/late.mp4']);
  });

  it('waits for a stream consumer and cancels when it disconnects', async () => {
    const fake = fakeDownloader();
    const removed: string[] = [];
    let writerEnded = 0;
    const manager = new TaskManager(fake.downloader, {
      createId: () => 'stream',
      createWriter: () => ({ write() {}, end: () => ++writerEnded }),
      removeFile: async (path) => {
        removed.push(path);
      },
    });
    managers.push(manager);
    manager.create({ url: 'https://test/stream.m3u8', stream: true });
    expect(manager.get('stream')?.status).toBe('queued');
    const attached = manager.attachStream('stream');
    expect(attached.kind).toBe('ok');
    if (attached.kind !== 'ok') return;
    await attached.stream.cancel();
    expect(manager.get('stream')?.status).toBe('cancelled');
    expect(manager.attachStream('stream').kind).toBe('terminal');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writerEnded).toBe(1);
    expect(removed).toEqual([expect.stringContaining('stream.mp4')]);
  });

  it('errors a failed stream and releases its writer and partial file', async () => {
    const fake = fakeDownloader();
    const removed: string[] = [];
    let writerEnded = 0;
    fake.downloader.downloadToStream = async (_options, onChunk) => {
      onChunk(new Uint8Array([1]));
      throw new Error('stream failed');
    };
    const manager = new TaskManager(fake.downloader, {
      createId: () => 'failed-stream',
      createWriter: () => ({ write() {}, end: () => ++writerEnded }),
      removeFile: async (path) => {
        removed.push(path);
      },
    });
    managers.push(manager);
    manager.create({ url: 'https://test/fail.m3u8', stream: true });
    const attached = manager.attachStream('failed-stream');
    expect(attached.kind).toBe('ok');
    if (attached.kind !== 'ok') return;
    const reader = attached.stream.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await expect(reader.read()).rejects.toThrow('stream failed');
    expect(manager.get('failed-stream')?.status).toBe('failed');
    expect(writerEnded).toBe(1);
    expect(removed).toEqual([expect.stringContaining('failed-stream.mp4')]);
  });

  it('replays retained SSE events and snapshots after history eviction', async () => {
    const fake = fakeDownloader();
    const manager = new TaskManager(fake.downloader, {
      createId: () => 'history',
      historyLimit: 2,
    });
    managers.push(manager);
    manager.create({ url: 'https://test/history.m3u8' });
    manager.handleSdkEvent(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
      operationId: 'history',
      total: 2,
      completed: 1,
    });
    manager.handleSdkEvent(HlsDownloaderEvent.DOWNLOADING_SEGMENTS, {
      operationId: 'history',
      total: 2,
      completed: 2,
    });

    expect(manager.eventsAfter('history', 2)?.map((event) => event.id)).toEqual([3, 4]);
    expect(manager.eventsAfter('history', 0)?.[0]?.event).toBe('snapshot');
  });

  it('expires output and removes the tombstone', async () => {
    const fake = fakeDownloader();
    const removed: string[] = [];
    const manager = new TaskManager(fake.downloader, {
      createId: () => 'expiry',
      fileExpiryMs: 10,
      tombstoneMs: 50,
      removeFile: async (path) => {
        removed.push(path);
      },
    });
    managers.push(manager);
    manager.create({ url: 'https://test/expiry.m3u8' });
    fake.downloads[0]!.resolve({ filePath: '/tmp/expiry.mp4', totalSegments: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.get('expiry')?.status).toBe('expired');
    expect(removed).toEqual(['/tmp/expiry.mp4']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.get('expiry')).toBeUndefined();
  });
});

describe('Bun API', () => {
  it('exposes idempotent cancellation and terminal SSE snapshots', async () => {
    const fake = fakeDownloader();
    const manager = new TaskManager(fake.downloader, { createId: () => 'api-task' });
    managers.push(manager);
    const app = createApp(manager);
    const created = await app.handle(
      new Request('http://test/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://test/media.m3u8' }),
      }),
    );
    expect(created.status).toBe(202);

    const cancelled = await app.handle(
      new Request('http://test/downloads/api-task/cancel', { method: 'POST' }),
    );
    expect(cancelled.status).toBe(200);
    const repeated = await app.handle(
      new Request('http://test/downloads/api-task/cancel', { method: 'POST' }),
    );
    expect(repeated.status).toBe(200);

    const replay = await app.handle(
      new Request('http://test/downloads/api-task/events', {
        headers: { 'Last-Event-ID': '2' },
      }),
    );
    const replayBody = await replay.text();
    expect(replayBody).toContain('id: 3');
    expect(replayBody).toContain('event: cancelled');
    expect(replayBody).not.toContain('event: snapshot');

    const events = await app.handle(new Request('http://test/downloads/api-task/events'));
    const body = await events.text();
    expect(body).toContain('event: snapshot');
    expect(body).toContain('"status":"cancelled"');
    expect(body).toMatch(/^id: \d+/);
  });
});
