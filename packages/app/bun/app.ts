import { Elysia, t } from 'elysia';
import { getDownloadOutputFilename, getTranscodeMimeType } from '@hls-downloader/shared';
import { TaskManager, type TaskEvent } from './task-manager';

const ok = <T>(data: T, msg = '') => ({ successful: true, data, msg });
const fail = (msg: string) => ({ successful: false, data: null, msg });
const encodeSse = (event: TaskEvent) =>
  new TextEncoder().encode(
    `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
  );

function createSseResponse(manager: TaskManager, taskId: string, lastEventId?: string): Response {
  const parsed = lastEventId && /^\d+$/.test(lastEventId) ? Number(lastEventId) : undefined;
  const initial = manager.eventsAfter(taskId, parsed);
  if (!initial) return Response.json(fail('Task not found'), { status: 404 });
  let unsubscribe: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of initial) controller.enqueue(encodeSse(event));
      const state = initial.at(-1)?.data.status;
      if (state && ['completed', 'failed', 'cancelled', 'expired'].includes(state))
        return controller.close();
      unsubscribe = manager.subscribe(taskId, (event) => {
        try {
          controller.enqueue(encodeSse(event));
          if (['completed', 'error', 'cancelled', 'expired'].includes(event.event)) {
            unsubscribe?.();
            controller.close();
          }
        } catch {
          unsubscribe?.();
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

export function createApp(manager: TaskManager) {
  return new Elysia()
    .post(
      '/poster',
      async ({ body, status }) => {
        try {
          const poster = await manager.poster(body.url, body.headers);
          return poster ? ok(poster) : status(404, fail('No poster found'));
        } catch (error) {
          return status(
            500,
            fail(error instanceof Error ? error.message : 'Failed to extract poster'),
          );
        }
      },
      {
        body: t.Object({ url: t.String(), headers: t.Optional(t.Record(t.String(), t.String())) }),
      },
    )
    .post('/download', ({ body, status }) => status(202, ok(manager.create(body))), {
      body: t.Object({
        url: t.String(),
        headers: t.Optional(t.Record(t.String(), t.String())),
        filename: t.Optional(t.String()),
        stream: t.Optional(t.Boolean()),
        transcode: t.Optional(
          t.Object({
            preset: t.Optional(t.Union([t.Literal('h264'), t.Literal('hevc'), t.Literal('vp9')])),
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
    })
    .get('/downloads/:id', ({ params, status }) => {
      const task = manager.get(params.id);
      return task ? ok(task) : status(404, fail('Task not found'));
    })
    .post('/downloads/:id/cancel', ({ params, status }) => {
      const result = manager.cancel(params.id);
      if (result.kind === 'missing') return status(404, fail('Task not found'));
      if (result.kind === 'conflict')
        return status(409, fail(`Task is already ${result.task?.status}`));
      return ok(result.task);
    })
    .get('/downloads/:id/events', ({ params, headers }) =>
      createSseResponse(manager, params.id, headers['last-event-id']),
    )
    .get('/downloads/:id/stream', ({ params }) => {
      const result = manager.attachStream(params.id);
      if (result.kind === 'missing') return Response.json(fail('Task not found'), { status: 404 });
      if (result.kind === 'not-stream')
        return Response.json(fail('Task was not started in streaming mode'), { status: 409 });
      if (result.kind === 'claimed')
        return Response.json(fail('Task stream already has a consumer'), { status: 409 });
      if (result.kind === 'terminal')
        return Response.json(fail('Task is already terminal'), { status: 409 });
      if (result.kind !== 'ok')
        return Response.json(fail('Unable to attach stream'), { status: 409 });
      return new Response(result.stream, {
        headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-cache' },
      });
    })
    .get('/downloads/:id/file', async ({ params }) => {
      const task = manager.get(params.id);
      if (!task) return Response.json(fail('Task not found'), { status: 404 });
      if (task.status === 'expired')
        return Response.json(fail('File has expired'), { status: 410 });
      if (task.status !== 'completed')
        return Response.json(fail('Download not yet completed'), { status: 409 });
      const path = manager.getFilePath(task.id);
      if (!path) return Response.json(fail('File path not available'), { status: 500 });
      const file = Bun.file(path);
      if (!(await file.exists())) return Response.json(fail('File has expired'), { status: 410 });
      return new Response(file, {
        headers: {
          'Content-Type': task.transcode ? getTranscodeMimeType(task.transcode) : 'video/mp4',
          'Content-Length': String(file.size),
          'Content-Disposition': `attachment; filename="${getDownloadOutputFilename(task.filename, task.transcode)}"`,
        },
      });
    });
}
