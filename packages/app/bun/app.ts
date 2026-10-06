import { timelineOptions, presentationRange, trackSelection } from './timeline-schema';
import { Elysia, t } from 'elysia';
import { getDownloadOutputFilename, getTranscodeMimeType } from '@hls-downloader/shared';
import { TaskManager, type TaskEvent } from './task-manager';

const audioSelection = t.Optional(
  t.Union([
    t.Object({ groupId: t.String(), name: t.String() }),
    t.Object({ language: t.String() }),
  ]),
);
const variantSelection = t.Optional(
  t.Object({
    maxResolution: t.Optional(t.Object({ width: t.Number(), height: t.Number() })),
    maxBandwidth: t.Optional(t.Number()),
    preferredCodec: t.Optional(t.String()),
    preferredAudio: t.Optional(t.String()),
    includeAudioOnly: t.Optional(t.Boolean()),
  }),
);

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
      if (
        state &&
        !initial.at(-1)?.data.settling &&
        ['completed', 'failed', 'cancelled', 'expired'].includes(state)
      )
        return controller.close();
      unsubscribe = manager.subscribe(taskId, (event) => {
        try {
          controller.enqueue(encodeSse(event));
          if (
            !event.data.settling &&
            ['completed', 'error', 'cancelled', 'expired'].includes(event.event)
          ) {
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
    .post(
      '/subtitles',
      async ({ body, request, status }) => {
        try {
          return ok(await manager.subtitles({ ...body, signal: request.signal }));
        } catch (error) {
          return status(
            422,
            fail(error instanceof Error ? error.message : 'Subtitle export failed'),
          );
        }
      },
      {
        body: t.Object({
          url: t.String(),
          headers: t.Optional(t.Record(t.String(), t.String())),
          variant: variantSelection,
          audio: audioSelection,
          subtitle: t.Object({ groupId: t.String(), name: t.String() }),
        }),
      },
    )
    .post(
      '/download',
      ({ body, status }) => {
        try {
          return status(202, ok(manager.create(body)));
        } catch (error) {
          return status(
            422,
            fail(error instanceof Error ? error.message : 'Invalid download options'),
          );
        }
      },
      {
        body: t.Object({
          url: t.String(),
          headers: t.Optional(t.Record(t.String(), t.String())),
          filename: t.Optional(t.String()),
          stream: t.Optional(t.Boolean()),
          timeline: timelineOptions,
          variant: variantSelection,
          audio: audioSelection,
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
      },
    )
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
    .get('/downloads/:id/file', ({ params }) => fileResponse(manager, params.id))
    .get('/downloads/:id/files/:index', ({ params }) =>
      fileResponse(manager, params.id, params.index),
    )
    .get('/downloads/:id/report', ({ params }) => {
      const error = timelineTaskError(manager, params.id);
      return error ?? ok(manager.get(params.id)!.timelineReport);
    })
    .post(
      '/downloads/:id/subtitles',
      async ({ params, body, request, status }) => {
        const error = timelineTaskError(manager, params.id);
        if (error) return error;
        try {
          return ok(await manager.subtitleOutputs(params.id, { ...body, signal: request.signal }));
        } catch {
          return status(
            422,
            fail('Subtitle export failed: synchronization evidence or resource unavailable'),
          );
        }
      },
      {
        body: t.Object({
          subtitle: t.Object({ groupId: t.String(), name: t.String() }),
          track: trackSelection,
          filename: t.Optional(t.String()),
        }),
      },
    )
    .post(
      '/downloads/:id/chapters',
      ({ params, body, status }) => {
        const error = timelineTaskError(manager, params.id);
        if (error) return error;
        try {
          return ok(manager.chapters(params.id, body));
        } catch {
          return status(422, fail('Chapter intervals or timeline mapping invalid'));
        }
      },
      {
        body: t.Object({
          chapters: t.Array(
            t.Object({ range: presentationRange, title: t.String(), id: t.Optional(t.String()) }),
          ),
          track: trackSelection,
          filename: t.Optional(t.String()),
        }),
      },
    );
}

function timelineTaskError(manager: TaskManager, id: string): Response | undefined {
  const task = manager.get(id);
  if (!task) return Response.json(fail('Task not found'), { status: 404 });
  if (task.status === 'expired') return Response.json(fail('File has expired'), { status: 410 });
  if (task.status !== 'completed' || !task.timelineReport)
    return Response.json(fail('A completed timeline download is required'), { status: 409 });
}
async function fileResponse(manager: TaskManager, id: string, index?: string): Promise<Response> {
  const task = manager.get(id);
  if (!task) return Response.json(fail('Task not found'), { status: 404 });
  if (task.status === 'expired') return Response.json(fail('File has expired'), { status: 410 });
  const output = task.outputs?.find((value) => value.index === index);
  if (index !== undefined && !output)
    return Response.json(fail('Output not available'), { status: 404 });
  if (index === undefined && (task.outputs?.length ?? 0) > 1)
    return Response.json(fail('Choose an output from the task outputs list'), { status: 409 });
  if (task.status !== 'completed' && !output)
    return Response.json(fail('Download not yet completed'), { status: 409 });
  const path = manager.getFilePath(id, index);
  if (!path) return Response.json(fail('File path not available'), { status: 500 });
  const file = Bun.file(path);
  if (!(await file.exists())) return Response.json(fail('File has expired'), { status: 410 });
  const filename = output?.filename ?? getDownloadOutputFilename(task.filename, task.transcode);
  return new Response(file, {
    headers: {
      'Content-Type': task.transcode ? getTranscodeMimeType(task.transcode) : 'video/mp4',
      'Content-Length': String(file.size),
      'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
