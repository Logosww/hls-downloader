import { Elysia, t } from 'elysia';
import { NodeAdapter } from '@hls-downloader/adapters/node';
import { HlsDownloader } from '@hls-downloader/core';
import {
  getDownloadOutputFilename,
  getTranscodeMimeType,
  HlsDownloaderEvent,
  type HlsDownloaderTranscodeOptions,
} from '@hls-downloader/shared';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'downloading' | 'completed' | 'failed';

interface DownloadTask {
  id: string;
  status: TaskStatus;
  url: string;
  filename: string;
  transcode?: HlsDownloaderTranscodeOptions;
  filePath?: string;
  totalSegments?: number;
  error?: string;
  createdAt: number;
  expiresAt?: number;
  stream?: boolean;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  streamPromise?: Promise<ReadableStream<Uint8Array>>;
  // 流式任务：Bun.write(fileBranch) 的 Promise，/file endpoint 在返回前需 await
  // 避免客户端拿到 status=completed 但文件尚未写完的不完整文件
  fileWritePromise?: Promise<number>;
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
        event === HlsDownloaderEvent.STITCHING_SEGMENTS) &&
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

    const downloadOption = {
      url: task.url,
      headers,
      filename: task.filename,
      transcode: task.transcode,
    };
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

// 流式下载：先把 ReadableStream 创建出来暴露给 /stream endpoint，
// 同时通过 tee() 分叉一路写文件，实现「边推流 + 边落盘」。
// 字节流向：crate → duplex → NAPI on_chunk → ReadableStream.tee()
//   ├─ branch 1 → HTTP response（/stream endpoint 实时消费）
//   └─ branch 2 → Bun.write(filePath)（后台落盘，task 完成后 /file 可用）
// tee 内置背压与顺序保证，两个 branch 独立消费。
function startStreamDownload(task: DownloadTask, headers?: Record<string, string>) {
  task.streamPromise = new Promise<ReadableStream<Uint8Array>>((resolveStream) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        task.streamController = controller;
      },
    });

    // 立即 tee（必须在第一次 enqueue 之前）
    const [httpBranch, fileBranch] = stream.tee();
    resolveStream(httpBranch);

    // 后台落盘：task 完成后 task.filePath 可用，/file endpoint 可访问
    // 注意：Bun.write(path, readableStream) 存在 bug，只写 23 字节。
    // 改用 reader 手动读取 fileBranch + Bun.file.writer() 流式写入。
    const filePath = join(process.cwd(), `${task.id}.mp4`);
    task.filePath = filePath;
    task.fileWritePromise = (async () => {
      const writer = Bun.file(filePath).writer();
      const reader = fileBranch.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
        await writer.end();
      } catch (err) {
        console.error(`[task ${task.id}] file write failed:`, err);
        throw err;
      }
    })();
  });

  // 异步启动 transmux，写到 streamController
  (async () => {
    try {
      currentTaskId = task.id;
      task.status = 'downloading';
      emitTaskEvent(task.id, 'status', taskToResponse(task));

      const result = await downloader.downloadToStream(
        {
          url: task.url,
          headers,
          filename: task.filename,
        },
        (bytes: Uint8Array) => {
          task.streamController?.enqueue(bytes);
        },
      );

      task.totalSegments = result.totalSegments;
      task.streamController?.close();
      task.status = 'completed';
      task.expiresAt = Date.now() + FILE_EXPIRY_MS;
      scheduleCleanup(task);
      emitTaskEvent(task.id, 'completed', taskToResponse(task));
    } catch (err: unknown) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : 'Unknown error';
      task.streamController?.error(err);
      emitTaskEvent(task.id, 'error', taskToResponse(task));
    } finally {
      if (currentTaskId === task.id) currentTaskId = null;
    }
  })();
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
        transcode: body.transcode,
        stream: body.stream ?? false,
        createdAt: Date.now(),
      };

      tasks.set(task.id, task);
      if (task.stream) {
        startStreamDownload(task, body.headers);
      } else {
        processDownload(task, body.headers);
      }

      set.status = 202;
      return ok(taskToResponse(task));
    },
    {
      body: t.Object({
        url: t.String(),
        headers: t.Optional(t.Record(t.String(), t.String())),
        filename: t.Optional(t.String()),
        stream: t.Optional(t.Boolean()),
        transcode: t.Optional(
          t.Object({
            preset: t.Optional(
              t.Union([t.Literal('h264'), t.Literal('hevc'), t.Literal('vp9')]),
            ),
            videoCodec: t.Optional(t.String()),
            audioCodec: t.Optional(t.String()),
            format: t.Optional(t.String()),
            crf: t.Optional(t.Number()),
            videoBitrate: t.Optional(t.Union([t.String(), t.Number()])),
            audioBitrate: t.Optional(t.Union([t.String(), t.Number()])),
            speed: t.Optional(
              t.Union([
                t.Literal('ultrafast'),
                t.Literal('superfast'),
                t.Literal('veryfast'),
                t.Literal('faster'),
                t.Literal('fast'),
                t.Literal('medium'),
                t.Literal('slow'),
                t.Literal('slower'),
                t.Literal('veryslow'),
              ]),
            ),
          }),
        ),
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

  .get('/downloads/:id/stream', async ({ params, set }) => {
    const task = tasks.get(params.id);
    if (!task) {
      set.status = 404;
      return fail('Task not found');
    }
    if (!task.stream) {
      set.status = 409;
      return fail('Task was not started in streaming mode; use POST /download with stream:true');
    }
    if (!task.streamPromise) {
      set.status = 409;
      return fail('Streaming task has not been initialized');
    }
    const stream = await task.streamPromise;
    return new Response(stream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache',
      },
    });
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

    // 流式任务：等待 Bun.write 落盘完成，避免返回不完整文件
    if (task.fileWritePromise) {
      try {
        await task.fileWritePromise;
      } catch {
        set.status = 500;
        return fail('File write failed during streaming');
      }
    }

    const file = Bun.file(task.filePath);
    if (!(await file.exists())) {
      set.status = 410;
      return fail('File has expired or been deleted');
    }

    return new Response(file, {
      headers: {
        'Content-Type': task.transcode ? getTranscodeMimeType(task.transcode) : 'video/mp4',
        'Content-Length': String(file.size),
        'Content-Disposition': `attachment; filename="${getDownloadOutputFilename(task.filename, task.transcode)}"`,
      },
    });
  })

  .listen(PORT);

console.log(`HLS Downloader API running at http://localhost:${app.server?.port}`);
