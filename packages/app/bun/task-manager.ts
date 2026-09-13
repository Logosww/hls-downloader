import type {
  HlsDownloaderEvent,
  HlsDownloaderEventPayload,
  HlsDownloaderTranscodeOptions,
} from '@hls-downloader/shared';
import { HlsDownloaderErrorCode } from '@hls-downloader/shared';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type TaskStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';
export type TaskProgress = { total: number; completed: number };

export type DownloadTaskResponse = {
  id: string;
  status: TaskStatus;
  url: string;
  filename: string;
  transcode?: HlsDownloaderTranscodeOptions;
  totalSegments?: number;
  error?: string;
  progress?: TaskProgress;
  createdAt: number;
  expiresAt?: number;
  stream: boolean;
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
    transcode?: HlsDownloaderTranscodeOptions;
    operationId: string;
    signal: AbortSignal;
  }): Promise<{ filePath: string; totalSegments: number; operationId?: string }>;
  downloadToStream(
    options: {
      url: string;
      headers?: Record<string, string>;
      filename: string;
      operationId: string;
      signal: AbortSignal;
    },
    onChunk: (bytes: Uint8Array) => void,
  ): Promise<{ totalSegments: number; operationId?: string }>;
};

type FileWriter = { write(bytes: Uint8Array): unknown; end(): Promise<number> | number };
type DownloadTask = DownloadTaskResponse & {
  headers?: Record<string, string>;
  controller: AbortController;
  revision: number;
  nextEventId: number;
  history: TaskEvent[];
  subscribers: Set<(event: TaskEvent) => void>;
  streamAttached: boolean;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  writer?: FileWriter;
  filePath?: string;
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
    const task: DownloadTask = {
      id: this.#createId(),
      status: 'queued',
      url: input.url,
      headers: input.headers,
      filename: input.filename ?? 'output',
      transcode: input.transcode,
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
  getFilePath(id: string): string | undefined {
    return this.#tasks.get(id)?.filePath;
  }

  async poster(url: string, headers?: Record<string, string>): Promise<string | undefined> {
    await this.#downloader.init();
    return await this.#downloader.getPosterUrl({ url, headers });
  }

  cancel(id: string): { kind: 'ok' | 'conflict' | 'missing'; task?: DownloadTaskResponse } {
    const task = this.#tasks.get(id);
    if (!task) return { kind: 'missing' };
    if (task.status === 'cancelled') return { kind: 'ok', task: this.toResponse(task) };
    if (task.status !== 'queued' && task.status !== 'downloading') {
      return { kind: 'conflict', task: this.toResponse(task) };
    }
    task.revision++;
    task.status = 'cancelled';
    task.error = undefined;
    task.controller.abort();
    try {
      task.streamController?.error(new DOMException('Operation aborted', 'AbortError'));
    } catch {}
    void this.#finishWriter(task);
    void this.#removeTaskFile(task);
    this.#emit(task, 'cancelled');
    this.#scheduleExpiry(task);
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
    task.writer = this.#createWriter(task.filePath);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        task.streamController = controller;
      },
      cancel: () => {
        this.cancel(task.id);
      },
    });
    this.#pump();
    return { kind: 'ok', stream };
  }

  handleSdkEvent<E extends HlsDownloaderEvent>(
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
      void this.#finishWriter(task);
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
      totalSegments: task.totalSegments,
      error: task.error,
      progress: task.progress,
      createdAt: task.createdAt,
      expiresAt: task.expiresAt,
      stream: task.stream,
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
      if (task.stream) await this.#runStream(task, revision);
      else await this.#runDownload(task, revision);
    } catch (error) {
      if (task.revision !== revision) return;
      task.status = this.#isAbort(error) ? 'cancelled' : 'failed';
      task.error = this.#isAbort(error)
        ? undefined
        : error instanceof Error
          ? error.message
          : 'Unknown error';
      try {
        task.streamController?.error(error);
      } catch {}
      await this.#finishWriter(task);
      await this.#removeTaskFile(task);
      this.#emit(task, task.status === 'cancelled' ? 'cancelled' : 'error');
      this.#scheduleExpiry(task);
    }
  }

  async #runDownload(task: DownloadTask, revision: number): Promise<void> {
    const result = await this.#downloader.download({
      url: task.url,
      headers: task.headers,
      filename: task.filename,
      transcode: task.transcode,
      operationId: task.id,
      signal: task.controller.signal,
    });
    if (task.revision !== revision || task.status !== 'downloading') {
      await this.#removeFile(result.filePath);
      return;
    }
    task.filePath = result.filePath;
    task.totalSegments = result.totalSegments;
    task.status = 'completed';
    this.#emit(task, 'completed');
    this.#scheduleExpiry(task);
  }

  async #runStream(task: DownloadTask, revision: number): Promise<void> {
    const result = await this.#downloader.downloadToStream(
      {
        url: task.url,
        headers: task.headers,
        filename: task.filename,
        operationId: task.id,
        signal: task.controller.signal,
      },
      (bytes) => {
        if (task.revision !== revision || task.status !== 'downloading') return;
        task.writer?.write(bytes);
        task.streamController?.enqueue(bytes);
      },
    );
    if (task.revision !== revision || task.status !== 'downloading') return;
    task.totalSegments = result.totalSegments;
    await this.#finishWriter(task);
    task.streamController?.close();
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
    if (TERMINAL.has(task.status)) task.subscribers.clear();
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

  async #removeTaskFile(task: DownloadTask): Promise<void> {
    if (task.filePath) await this.#removeFile(task.filePath);
  }
  async #finishWriter(task: DownloadTask): Promise<void> {
    const writer = task.writer;
    task.writer = undefined;
    if (writer) {
      try {
        await writer.end();
      } catch {}
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
