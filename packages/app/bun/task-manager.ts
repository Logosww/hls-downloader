import type {
  AudioSelection,
  VariantSelectOptions,
  HlsDownloaderSubtitleOptions,
  HlsDownloaderSubtitleResult,
  HlsDownloaderEvent,
  HlsDownloaderEventPayload,
  HlsDownloaderTranscodeOptions,
  HlsMultiTimelineOptions,
  HlsTimelineOptions,
  HlsTimelineReport,
  HlsCompletedOutput,
  HlsDownloaderSubtitleOutputsOptions,
  HlsChapterOptions,
} from '@hls-downloader/shared';
import {
  HlsDownloaderErrorCode,
  exportChapters,
  getDownloadOutputFilename,
} from '@hls-downloader/shared';
import { randomUUID } from 'node:crypto';
import { unlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type TaskStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';
export type TaskProgress = { total: number; completed: number };

export type TaskFile = { index: string; filename: string };

export type DownloadTaskResponse = {
  id: string;
  status: TaskStatus;
  url: string;
  filename: string;
  variant?: VariantSelectOptions;
  audio?: AudioSelection;
  transcode?: HlsDownloaderTranscodeOptions;
  timeline?: HlsMultiTimelineOptions;
  timelineReport?: HlsTimelineReport;
  outputs?: TaskFile[];
  errorCode?: string;
  totalSegments?: number;
  error?: string;
  progress?: TaskProgress;
  createdAt: number;
  expiresAt?: number;
  stream: boolean;
  settling?: boolean;
};

export type TaskEvent = {
  id: number;
  event: 'snapshot' | 'status' | 'progress' | 'completed' | 'error' | 'cancelled' | 'expired';
  data: DownloadTaskResponse;
};

export type CreateTaskInput = {
  url: string;
  headers?: Record<string, string>;
  filename?: string;
  stream?: boolean;
  timeline?: HlsMultiTimelineOptions;
  variant?: VariantSelectOptions;
  audio?: AudioSelection;
  transcode?: HlsDownloaderTranscodeOptions;
};

export type DownloaderLike = {
  init(): Promise<void>;
  getPosterUrl(options: {
    url: string;
    headers?: Record<string, string>;
  }): Promise<string | undefined>;
  download(options: {
    url: string;
    headers?: Record<string, string>;
    filename: string;
    variant?: VariantSelectOptions;
    audio?: AudioSelection;
    transcode?: HlsDownloaderTranscodeOptions;
    timeline?: HlsTimelineOptions;
    operationId: string;
    signal: AbortSignal;
  }): Promise<{
    filePath: string;
    totalSegments: number;
    operationId?: string;
    timelineReport?: HlsTimelineReport;
  }>;
  downloadToWritable(
    options: {
      url: string;
      headers?: Record<string, string>;
      filename: string;
      variant?: VariantSelectOptions;
      audio?: AudioSelection;
      timeline?: HlsTimelineOptions;
      operationId: string;
      signal: AbortSignal;
    },
    writable: WritableStream<Uint8Array>,
  ): Promise<{ totalSegments: number; operationId?: string; timelineReport?: HlsTimelineReport }>;
  downloadOutputs?: import('@hls-downloader/core').HlsDownloader<
    import('@hls-downloader/adapters/node').HlsDownloaderNodeAdapter
  >['downloadOutputs'];
  downloadSubtitleOutputs?: import('@hls-downloader/core').HlsDownloader<
    import('@hls-downloader/adapters/node').HlsDownloaderNodeAdapter
  >['downloadSubtitleOutputs'];
  downloadSubtitles(options: HlsDownloaderSubtitleOptions): Promise<HlsDownloaderSubtitleResult>;
};

type FileWriter = {
  write(bytes: Uint8Array): unknown;
  flush?(): unknown;
  end(): Promise<number> | number;
};
type DownloadTask = DownloadTaskResponse & {
  headers?: Record<string, string>;
  controller: AbortController;
  revision: number;
  nextEventId: number;
  history: TaskEvent[];
  subscribers: Set<(event: TaskEvent) => void>;
  streamAttached: boolean;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  wakeStream?: () => void;
  writer?: FileWriter;
  writerFinishing?: Promise<void>;
  filePath?: string;
  files?: Array<TaskFile & { filePath: string }>;
  streamOutputClosed?: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
  tombstoneTimer?: ReturnType<typeof setTimeout>;
};

export type TaskManagerOptions = {
  maxActiveTasks?: number;
  fileExpiryMs?: number;
  tombstoneMs?: number;
  historyLimit?: number;
  outputDirectory?: string;
  createId?: () => string;
  now?: () => number;
  removeFile?: (path: string) => Promise<void>;
  createWriter?: (path: string) => FileWriter;
};

const TERMINAL = new Set<TaskStatus>(['completed', 'failed', 'cancelled', 'expired']);

export class TaskManager {
  readonly #tasks = new Map<string, DownloadTask>();
  readonly #queue: string[] = [];
  readonly #downloader: DownloaderLike;
  readonly #maxActiveTasks: number;
  readonly #fileExpiryMs: number;
  readonly #tombstoneMs: number;
  readonly #historyLimit: number;
  readonly #outputDirectory: string;
  readonly #createId: () => string;
  readonly #now: () => number;
  readonly #removeFile: (path: string) => Promise<void>;
  readonly #createWriter: (path: string) => FileWriter;
  #activeTasks = 0;

  constructor(downloader: DownloaderLike, options: TaskManagerOptions = {}) {
    this.#downloader = downloader;
    this.#maxActiveTasks = Math.max(1, options.maxActiveTasks ?? 3);
    this.#fileExpiryMs = Math.max(1, options.fileExpiryMs ?? 30 * 60 * 1_000);
    this.#tombstoneMs = Math.max(1, options.tombstoneMs ?? 5 * 60 * 1_000);
    this.#historyLimit = Math.max(1, options.historyLimit ?? 100);
    this.#outputDirectory = options.outputDirectory ?? process.cwd();
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#removeFile =
      options.removeFile ?? (async (path) => void (await unlink(path).catch(() => {})));
    this.#createWriter =
      options.createWriter ?? ((path) => Bun.file(path).writer() as unknown as FileWriter);
  }

  get activeTasks(): number {
    return this.#activeTasks;
  }
  get size(): number {
    return this.#tasks.size;
  }

  create(input: CreateTaskInput): DownloadTaskResponse {
    if (input.timeline && input.transcode)
      throw new Error('Timeline downloads do not support transcoding');
    if (input.stream && input.timeline?.changePolicy === 'split')
      throw new Error('Streaming requires changePolicy fail; use file outputs for split');
    const task: DownloadTask = {
      id: this.#createId(),
      status: 'queued',
      url: input.url,
      headers: input.headers ? { ...input.headers } : undefined,
      timeline: input.timeline ? structuredClone(input.timeline) : undefined,
      filename: input.filename ?? 'output',
      transcode: input.transcode,
      variant: input.variant
        ? {
            ...input.variant,
            maxResolution: input.variant.maxResolution
              ? { ...input.variant.maxResolution }
              : undefined,
          }
        : undefined,
      audio: input.audio ? { ...input.audio } : undefined,
      createdAt: this.#now(),
      stream: input.stream ?? false,
      controller: new AbortController(),
      revision: 0,
      nextEventId: 1,
      history: [],
      subscribers: new Set(),
      streamAttached: false,
    };
    this.#tasks.set(task.id, task);
    this.#queue.push(task.id);
    this.#emit(task, 'status');
    this.#pump();
    return this.toResponse(task);
  }

  get(id: string): DownloadTaskResponse | undefined {
    const task = this.#tasks.get(id);
    return task ? this.toResponse(task) : undefined;
  }
  getFilePath(id: string, index?: string): string | undefined {
    const task = this.#tasks.get(id);
    return index === undefined
      ? task?.filePath
      : task?.files?.find((file) => file.index === index)?.filePath;
  }

  async subtitleOutputs(
    id: string,
    options: Pick<
      HlsDownloaderSubtitleOutputsOptions,
      'subtitle' | 'track' | 'filename' | 'signal'
    >,
  ) {
    const task = this.#completedTimelineTask(id);
    if (!this.#downloader.downloadSubtitleOutputs)
      throw new Error('Timeline subtitles unavailable');
    return this.#downloader.downloadSubtitleOutputs({
      ...options,
      url: task.url,
      headers: task.headers,
      variant: task.variant,
      audio: task.audio,
      timelineReport: task.timelineReport!,
      operationId: `${id}:subtitles:${randomUUID()}`,
    });
  }
  chapters(id: string, options: Omit<HlsChapterOptions, 'timelineReport'>) {
    return exportChapters({
      ...options,
      timelineReport: this.#completedTimelineTask(id).timelineReport!,
    });
  }
  #completedTimelineTask(id: string): DownloadTask {
    const task = this.#tasks.get(id);
    if (!task || task.status !== 'completed' || !task.timelineReport)
      throw new Error('A completed timeline download is required');
    return task;
  }

  async poster(url: string, headers?: Record<string, string>): Promise<string | undefined> {
    await this.#downloader.init();
    return await this.#downloader.getPosterUrl({ url, headers });
  }

  async subtitles(options: HlsDownloaderSubtitleOptions): Promise<HlsDownloaderSubtitleResult> {
    return this.#downloader.downloadSubtitles(options);
  }

  cancel(id: string): { kind: 'ok' | 'conflict' | 'missing'; task?: DownloadTaskResponse } {
    const task = this.#tasks.get(id);
    if (!task) return { kind: 'missing' };
    if (task.status === 'cancelled') return { kind: 'ok', task: this.toResponse(task) };
    if (task.status !== 'queued' && task.status !== 'downloading') {
      return { kind: 'conflict', task: this.toResponse(task) };
    }
    const queued = task.status === 'queued';
    task.revision++;
    task.status = 'cancelled';
    task.settling = !queued;
    task.error = undefined;
    task.controller.abort();
    try {
      task.streamController?.error(new DOMException('Operation aborted', 'AbortError'));
    } catch {}
    task.wakeStream?.();
    void this.#finishWriter(task)
      .catch(() => {})
      .then(() => (task.streamOutputClosed ? undefined : this.#removePartialFile(task)));
    this.#emit(task, 'cancelled');
    if (queued) this.#scheduleExpiry(task);
    const queueIndex = this.#queue.indexOf(id);
    if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
    this.#pump();
    return { kind: 'ok', task: this.toResponse(task) };
  }

  attachStream(
    id: string,
  ):
    | { kind: 'ok'; stream: ReadableStream<Uint8Array> }
    | { kind: 'missing' | 'not-stream' | 'claimed' | 'terminal' } {
    const task = this.#tasks.get(id);
    if (!task) return { kind: 'missing' };
    if (!task.stream) return { kind: 'not-stream' };
    if (TERMINAL.has(task.status)) return { kind: 'terminal' };
    if (task.streamAttached) return { kind: 'claimed' };
    task.streamAttached = true;
    task.filePath = join(this.#outputDirectory, `${task.id}.mp4`);
    if (!task.timeline) task.writer = this.#createWriter(task.filePath);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        task.streamController = controller;
      },
      pull: () => {
        task.wakeStream?.();
      },
      cancel: () => {
        this.cancel(task.id);
      },
    });
    this.#pump();
    return { kind: 'ok', stream };
  }

  handleLibraryEvent<E extends HlsDownloaderEvent>(
    _event: E,
    payload: HlsDownloaderEventPayload<E>,
  ): void {
    const task = this.#tasks.get(payload.operationId);
    if (!task || task.status !== 'downloading') return;
    if (typeof payload.total === 'number' && typeof payload.completed === 'number') {
      task.progress = { total: payload.total, completed: payload.completed };
      this.#emit(task, 'progress');
    }
  }

  eventsAfter(id: string, lastEventId?: number): TaskEvent[] | undefined {
    const task = this.#tasks.get(id);
    if (!task) return undefined;
    if (lastEventId === undefined) return [this.#snapshot(task)];
    const first = task.history[0]?.id;
    return first !== undefined && lastEventId >= first - 1
      ? task.history.filter((event) => event.id > lastEventId)
      : [this.#snapshot(task)];
  }

  subscribe(id: string, callback: (event: TaskEvent) => void): (() => void) | undefined {
    const task = this.#tasks.get(id);
    if (!task) return undefined;
    task.subscribers.add(callback);
    return () => {
      task.subscribers.delete(callback);
    };
  }

  dispose(): void {
    for (const task of this.#tasks.values()) {
      clearTimeout(task.expiryTimer);
      clearTimeout(task.tombstoneTimer);
      task.controller.abort();
      task.subscribers.clear();
      task.wakeStream?.();
      void this.#finishWriter(task).catch(() => {});
    }
    this.#tasks.clear();
    this.#queue.length = 0;
  }

  toResponse(task: DownloadTask): DownloadTaskResponse {
    return {
      id: task.id,
      status: task.status,
      url: task.url,
      filename: task.filename,
      transcode: task.transcode,
      timeline: task.timeline,
      timelineReport: task.timelineReport,
      outputs: task.outputs?.map((output) => ({ ...output })),
      errorCode: task.errorCode,
      variant: task.variant,
      audio: task.audio,
      totalSegments: task.totalSegments,
      error: task.error,
      progress: task.progress,
      createdAt: task.createdAt,
      expiresAt: task.expiresAt,
      stream: task.stream,
      settling: task.settling,
    };
  }

  #pump(): void {
    while (this.#activeTasks < this.#maxActiveTasks) {
      const index = this.#queue.findIndex((id) => {
        const task = this.#tasks.get(id);
        return task?.status === 'queued' && (!task.stream || task.streamAttached);
      });
      if (index < 0) return;
      const [id] = this.#queue.splice(index, 1);
      const task = id ? this.#tasks.get(id) : undefined;
      if (!task || task.status !== 'queued') continue;
      this.#activeTasks++;
      void this.#run(task).finally(() => {
        this.#activeTasks--;
        this.#pump();
      });
    }
  }

  async #run(task: DownloadTask): Promise<void> {
    task.status = 'downloading';
    const revision = ++task.revision;
    this.#emit(task, 'status');
    try {
      if (task.stream && task.transcode) throw new Error('Streaming does not support transcoding');
      if (task.stream) await this.#runStream(task, revision);
      else await this.#runDownload(task, revision);
    } catch (error) {
      if (task.timeline && task.streamOutputClosed) await this.#retainOutputs(task, []);
      if (
        task.timeline &&
        error &&
        typeof error === 'object' &&
        'completedOutputs' in error &&
        Array.isArray(error.completedOutputs)
      ) {
        await this.#retainOutputs(task, error.completedOutputs as HlsCompletedOutput[]);
      }
      if (task.revision !== revision) {
        return;
      }
      task.errorCode =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
      task.status = this.#isAbort(error) ? 'cancelled' : 'failed';
      task.error = this.#isAbort(error)
        ? undefined
        : error instanceof Error
          ? error.message
          : 'Unknown error';
      try {
        task.streamController?.error(error);
      } catch {}
      await this.#finishWriter(task).catch(() => {});
      await this.#removePartialFile(task);
      this.#emit(task, task.status === 'cancelled' ? 'cancelled' : 'error');
      this.#scheduleExpiry(task);
    } finally {
      if (this.#tasks.has(task.id) && TERMINAL.has(task.status)) {
        const wasSettling = task.settling;
        task.settling = false;
        this.#scheduleExpiry(task);
        if (wasSettling) this.#emit(task, 'cancelled');
      }
    }
  }

  async #runDownload(task: DownloadTask, revision: number): Promise<void> {
    if (task.timeline) {
      if (!this.#downloader.downloadOutputs) throw new Error('Timeline outputs unavailable');
      const result = await this.#downloader.downloadOutputs({
        url: task.url,
        headers: task.headers,
        filename: task.id,
        timeline: task.timeline,
        variant: task.variant,
        audio: task.audio,
        operationId: task.id,
        signal: task.controller.signal,
      });
      const outputs = result.outputs.map((output) => ({
        ...result.timelineReport.outputs.find((item) => item.index === output.index)!,
        filePath: output.filePath,
      }));
      await this.#retainOutputs(task, outputs);
      if (task.revision !== revision || task.status !== 'downloading') return;
      task.timelineReport = result.timelineReport;
      task.totalSegments = result.totalSegments;
      task.status = 'completed';
      this.#scheduleExpiry(task);
      this.#emit(task, 'completed');
      return;
    }
    const result = await this.#downloader.download({
      url: task.url,
      headers: task.headers,
      filename: task.filename,
      transcode: task.transcode,
      variant: task.variant,
      audio: task.audio,
      operationId: task.id,
      signal: task.controller.signal,
    });
    if (task.revision !== revision || task.status !== 'downloading') {
      await this.#removeFile(result.filePath);
      return;
    }
    task.filePath = result.filePath;
    task.timelineReport = result.timelineReport;
    task.totalSegments = result.totalSegments;
    task.status = 'completed';
    this.#emit(task, 'completed');
    this.#scheduleExpiry(task);
  }

  async #runStream(task: DownloadTask, revision: number): Promise<void> {
    const result = await this.#downloader.downloadToWritable(
      {
        url: task.url,
        headers: task.headers,
        filename: task.filename,
        variant: task.variant,
        audio: task.audio,
        timeline: task.timeline,
        operationId: task.id,
        signal: task.controller.signal,
      },
      new WritableStream<Uint8Array>({
        write: async (bytes) => {
          task.controller.signal.throwIfAborted();
          while ((task.streamController?.desiredSize ?? 0) <= 0) {
            await new Promise<void>((resolve) => {
              task.wakeStream = resolve;
            });
            task.wakeStream = undefined;
            task.controller.signal.throwIfAborted();
          }
          task.writer ??= this.#createWriter(task.filePath!);
          await task.writer.write(bytes);
          await task.writer?.flush?.();
          task.controller.signal.throwIfAborted();
          task.streamController?.enqueue(bytes);
        },
        close: async () => {
          await this.#finishWriter(task);
          task.streamOutputClosed = true;
          task.controller.signal.throwIfAborted();
          task.streamController?.close();
        },
      }),
    );
    if (task.timeline && result.timelineReport && task.filePath) {
      await this.#retainOutputs(task, [
        { ...result.timelineReport.outputs[0]!, filePath: task.filePath },
      ]);
    }
    if (task.revision !== revision || task.status !== 'downloading') return;
    task.timelineReport = result.timelineReport;
    task.totalSegments = result.totalSegments;
    task.status = 'completed';
    this.#emit(task, 'completed');
    this.#scheduleExpiry(task);
  }

  #emit(task: DownloadTask, event: TaskEvent['event']): void {
    const item: TaskEvent = { id: task.nextEventId++, event, data: this.toResponse(task) };
    task.history.push(item);
    if (task.history.length > this.#historyLimit) task.history.shift();
    for (const subscriber of task.subscribers) {
      try {
        subscriber(item);
      } catch {}
    }
    if (TERMINAL.has(task.status) && !task.settling) task.subscribers.clear();
  }

  #snapshot(task: DownloadTask): TaskEvent {
    return {
      id: Math.max(0, task.nextEventId - 1),
      event: 'snapshot',
      data: this.toResponse(task),
    };
  }

  #scheduleExpiry(task: DownloadTask): void {
    if (task.expiryTimer || task.status === 'expired') return;
    task.expiresAt = this.#now() + this.#fileExpiryMs;
    const revision = task.revision;
    task.expiryTimer = setTimeout(() => void this.#expire(task.id, revision), this.#fileExpiryMs);
  }

  async #expire(id: string, revision: number): Promise<void> {
    const task = this.#tasks.get(id);
    if (!task || task.revision !== revision || !TERMINAL.has(task.status)) return;
    await this.#removeTaskFile(task);
    task.status = 'expired';
    task.expiresAt = this.#now();
    this.#emit(task, 'expired');
    task.tombstoneTimer = setTimeout(() => {
      this.#tasks.delete(id);
    }, this.#tombstoneMs);
  }

  async #retainOutputs(task: DownloadTask, outputs: HlsCompletedOutput[]): Promise<void> {
    if (!this.#tasks.has(task.id) || task.status === 'expired') {
      for (const output of outputs) if (output.filePath) await this.#removeFile(output.filePath);
      return;
    }
    if (task.stream && task.streamOutputClosed && task.filePath) {
      task.files = [
        { index: '0', filename: getDownloadOutputFilename(task.filename), filePath: task.filePath },
      ];
    } else {
      const files = task.files ?? [];
      for (const output of outputs) {
        if (!output.filePath || files.some((file) => file.index === output.index)) continue;
        const ordinal = (BigInt(output.index) + BigInt(1)).toString().padStart(3, '0');
        const target = join(this.#outputDirectory, `${task.id}.${ordinal}.mp4`);
        let path = output.filePath;
        // The SDK writes unique basenames. Relocate to the app's output directory;
        // retain the published path if relocation fails so completed media stays usable.
        if (resolve(path) !== resolve(target)) {
          try {
            await rename(path, target);
            path = target;
          } catch {}
        }
        if (!this.#tasks.has(task.id) || this.get(task.id)?.status === 'expired') {
          await this.#removeFile(path);
          continue;
        }
        files.push({
          index: output.index,
          filename: getDownloadOutputFilename(task.filename).replace(/\.mp4$/i, `.${ordinal}.mp4`),
          filePath: path,
        });
      }
      task.files = files;
    }
    task.outputs = task.files.map(({ index, filename }) => ({ index, filename }));
    if (task.files.length === 1) task.filePath = task.files[0]!.filePath;
  }
  async #removePartialFile(task: DownloadTask): Promise<void> {
    if (task.filePath && !task.files?.some((file) => file.filePath === task.filePath))
      await this.#removeFile(task.filePath);
  }
  async #removeTaskFile(task: DownloadTask): Promise<void> {
    const paths = new Set([task.filePath, ...(task.files?.map((file) => file.filePath) ?? [])]);
    for (const path of paths) if (path) await this.#removeFile(path);
    task.files = undefined;
    task.outputs = undefined;
    task.filePath = undefined;
  }
  async #finishWriter(task: DownloadTask): Promise<void> {
    if (task.writerFinishing) return task.writerFinishing;
    const writer = task.writer;
    task.writer = undefined;
    if (writer) {
      task.writerFinishing = Promise.resolve()
        .then(() => writer.end())
        .then(() => {});
      return task.writerFinishing;
    }
  }
  #isAbort(error: unknown): boolean {
    return (
      (error instanceof Error && error.name === 'AbortError') ||
      (!!error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === HlsDownloaderErrorCode.ABORTED)
    );
  }
}
