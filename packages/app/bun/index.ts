import { Elysia, t } from 'elysia';
import { NodeAdapter } from '@hls-downloader/adapters/node';
import { HlsDownloader } from '@hls-downloader/core';
import { getDownloadOutputFilename, HlsDownloaderEvent } from '@hls-downloader/shared';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

// ─── Types ───────────────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'downloading' | 'completed' | 'failed';

interface DownloadTask {
  id: string;
  status: TaskStatus;
  url: string;
  filename: string;
  filePath?: string;
  totalSegments?: number;
  error?: string;
  createdAt: number;
  expiresAt?: number;
}

type TaskEventCallback = (event: string, data: unknown) => void;

// ─── Response Helper ─────────────────────────────────────────────────────

function ok<T>(data: T, msg = '') {
  return { successful: true, data, msg };
}

function fail(msg: string) {
  return { successful: false, data: null, msg };
}

// ─── Config ──────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const FILE_EXPIRY_MS = Number(process.env.FILE_EXPIRY_MS) || 30 * 60 * 1000;

// ─── State ───────────────────────────────────────────────────────────────

const tasks = new Map<string, DownloadTask>();
const taskSubscribers = new Map<string, Set<TaskEventCallback>>();

// ─── HlsDownloader ───────────────────────────────────────────────────────

let currentTaskId: string | null = null;

const downloader = new HlsDownloader({
  adapter: NodeAdapter,
  onEvent: (event, progress) => {
    if (!currentTaskId) return;
    const task = tasks.get(currentTaskId);
    if (!task) return;

    if (event === HlsDownloaderEvent.STARTING_DOWNLOAD) {
      emitTaskEvent(task.id, 'status', taskToResponse(task));
    } else if (
      (event === HlsDownloaderEvent.DOWNLOADING_SEGMENTS ||
        event === HlsDownloaderEvent.STICHING_SEGMENTS) &&
      progress
    ) {
      emitTaskEvent(task.id, 'progress', {
        ...taskToResponse(task),
        progress: { total: progress.total, completed: progress.completed },
      });
    }
  },
});

// ─── Task Pub/Sub ────────────────────────────────────────────────────────

function emitTaskEvent(taskId: string, event: string, data: unknown) {
  const subs = taskSubscribers.get(taskId);
  if (!subs) return;
  for (const cb of subs) {
    try {
      cb(event, data);
    } catch {}
  }
  if (event === 'completed' || event === 'error') {
    taskSubscribers.delete(taskId);
  }
}

function subscribeTask(taskId: string, cb: TaskEventCallback): () => void {
  if (!taskSubscribers.has(taskId)) {
    taskSubscribers.set(taskId, new Set());
  }
  taskSubscribers.get(taskId)!.add(cb);
  return () => {
    taskSubscribers.get(taskId)?.delete(cb);
  };
}

// ─── Task Lifecycle ──────────────────────────────────────────────────────

function scheduleCleanup(task: DownloadTask) {
  task.expiresAt = Date.now() + FILE_EXPIRY_MS;
  setTimeout(async () => {
    if (task.filePath) {
      try {
        await unlink(task.filePath);
      } catch {}
    }
    tasks.delete(task.id);
  }, FILE_EXPIRY_MS);
}

function taskToResponse(task: DownloadTask) {
  const { filePath: _, ...rest } = task;
  return rest;
}

async function processDownload(task: DownloadTask, headers?: Record<string, string>) {
  try {
    currentTaskId = task.id;
    task.status = 'downloading';
    emitTaskEvent(task.id, 'status', taskToResponse(task));

    const downloadOption = { url: task.url, headers, filename: task.filename };
    const result = await downloader.download(downloadOption);

    if (!result) throw new Error('Download returned empty result');

    task.status = 'completed';
    task.filePath = result.filePath;
    task.totalSegments = result.totalSegments;
    scheduleCleanup(task);
    emitTaskEvent(task.id, 'completed', taskToResponse(task));
  } catch (err: unknown) {
    task.status = 'failed';
    task.error = err instanceof Error ? err.message : 'Unknown error';
    emitTaskEvent(task.id, 'error', taskToResponse(task));
  } finally {
    if (currentTaskId === task.id) currentTaskId = null;
  }
}

// ─── SSE Helper ──────────────────────────────────────────────────────────

function createSSEStream(task: DownloadTask): Response {
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      send('status', taskToResponse(task));

      if (task.status === 'completed' || task.status === 'failed') {
        controller.close();
        return;
      }

      cleanup = subscribeTask(task.id, (event, data) => {
        send(event, data);
        if (event === 'completed' || event === 'error') {
          cleanup?.();
          try {
            controller.close();
          } catch {}
        }
      });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────

const app = new Elysia()
  .post(
    '/poster',
    async ({ body, set }) => {
      try {
        await downloader.init();
        const posterUrl = await downloader.getPosterUrl({
          url: body.url,
          headers: body.headers,
        });

        if (!posterUrl) {
          set.status = 404;
          return fail('No poster found');
        }

        return ok(posterUrl);
      } catch (err: unknown) {
        set.status = 500;
        return fail(err instanceof Error ? err.message : 'Failed to extract poster');
      }
    },
    {
      body: t.Object({
        url: t.String(),
        headers: t.Optional(t.Record(t.String(), t.String())),
      }),
    },
  )

  .post(
    '/download',
    ({ body, set }) => {
      const task: DownloadTask = {
        id: randomUUID(),
        status: 'pending',
        url: body.url,
        filename: body.filename ?? 'output',
        createdAt: Date.now(),
      };

      tasks.set(task.id, task);
      processDownload(task, body.headers);

      set.status = 202;
      return ok(taskToResponse(task));
    },
    {
      body: t.Object({
        url: t.String(),
        headers: t.Optional(t.Record(t.String(), t.String())),
        filename: t.Optional(t.String()),
      }),
    },
  )

  .get('/downloads/:id', ({ params, set }) => {
    const task = tasks.get(params.id);
    if (!task) {
      set.status = 404;
      return fail('Task not found');
    }
    return ok(taskToResponse(task));
  })

  .get('/downloads/:id/events', ({ params }) => {
    const task = tasks.get(params.id);
    if (!task) {
      return new Response(JSON.stringify(fail('Task not found')), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return createSSEStream(task);
  })

  .get('/downloads/:id/file', async ({ params, set }) => {
    const task = tasks.get(params.id);
    if (!task) {
      set.status = 404;
      return fail('Task not found');
    }
    if (task.status !== 'completed') {
      set.status = 409;
      return fail('Download not yet completed');
    }
    if (!task.filePath) {
      set.status = 500;
      return fail('File path not available');
    }

    const file = Bun.file(task.filePath);
    if (!(await file.exists())) {
      set.status = 410;
      return fail('File has expired or been deleted');
    }

    return new Response(file, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(file.size),
        'Content-Disposition': `attachment; filename="${getDownloadOutputFilename(task.filename)}"`,
      },
    });
  })

  .listen(PORT);

console.log(`HLS Downloader API running at http://localhost:${app.server?.port}`);
