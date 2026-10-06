import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  normalizeHlsError,
  type HlsRecordingOptions,
  type HlsRecordingOutput,
  type HlsRecordingSession,
  type HlsRecordingState,
  type HlsRecordingDriver,
  type HlsRecordingHost,
  type HlsRecordingReport,
  type HlsRecordingOutputReport,
  type HlsRecordingEvent,
  type HlsRecordingResult,
} from '@hls-downloader/shared';

/** Owns public completion, sink lifetimes and bounded output history. */
export function createRecording<O extends HlsRecordingOutput>(
  options: HlsRecordingOptions<O>,
  run: (
    options: HlsRecordingOptions<O>,
    host: HlsRecordingHost,
  ) => Promise<{ report: HlsRecordingReport }>,
): HlsRecordingSession<O> {
  const operationId = options.operationId ?? globalThis.crypto.randomUUID();
  const controller = new AbortController();
  const aborted = () => new HlsDownloaderError(Code.ABORTED, 'Recording cancelled');
  let state: HlsRecordingState = 'preparing';
  let stopped = false,
    active = true,
    failure: unknown;
  let driver: HlsRecordingDriver | undefined;
  let ready!: (driver: HlsRecordingDriver) => void;
  let rejectReady!: (error: unknown) => void;
  const driverReady = new Promise<HlsRecordingDriver>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  void driverReady.catch(() => {});
  const writers = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();
  const paths = new Map<string, string>();
  const completed: HlsRecordingOutputReport[] = [];
  let truncated = false;
  let blobBytes: Uint8Array | undefined;
  const history = options.limits?.historyEntries ?? 128;
  const terminal = () => ['completed', 'failed', 'cancelled'].includes(state);
  const emit = (event: HlsRecordingEvent) => {
    if (!active) return;
    try {
      const returned: unknown = options.onEvent?.({ ...event, operationId });
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function')
        void Promise.resolve(returned).catch(() => {});
    } catch {
      /* Observers do not own execution. */
    }
  };
  const setState = (next: HlsRecordingState) => {
    if (terminal() || state === next) return;
    state = next;
    emit({ type: 'state', state });
  };
  const check = () => {
    if (failure) throw failure;
    if (!active || controller.signal.aborted) throw aborted();
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) return Promise.reject(failure ?? aborted());
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(failure ?? aborted());
      controller.signal.addEventListener('abort', abort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', abort));
    });
  };
  const failSink = (cause: unknown) => {
    failure ??= new HlsDownloaderError(Code.OUTPUT_WRITE_FAILED, 'Recording output failed', {
      cause,
    });
    controller.abort();
    void driver?.command({ action: 'cancel' }).catch(() => {});
    return failure;
  };
  const cancel = () => {
    if (terminal()) return;
    controller.abort();
    void driver?.command({ action: 'cancel' }).catch(() => {});
  };
  const stop = () => {
    if (terminal() || stopped) return;
    stopped = true;
    setState('draining');
    void driver?.command({ action: 'stop' }).catch((e) => {
      failure ??= e;
      cancel();
    });
  };
  const control: HlsRecordingHost['control'] = async (request) => {
    const publishedFile =
      request.action === 'event' &&
      request.event.type === 'output' &&
      (options.output.type === 'file' || options.output.type === 'files');
    if (!publishedFile) check();
    if (request.action === 'acquire') {
      const { index } = request.output;
      const out = options.output;
      try {
        if (out.type === 'file' || out.type === 'files') {
          const path =
            out.type === 'file'
              ? out.path
              : await wait(Promise.resolve().then(() => out.acquire(request.output)));
          check();
          if (typeof path !== 'string' || !path) throw new Error('Missing output path');
          paths.set(index, path);
          return path;
        }
        if (out.type === 'blob') return '';
        const pending = Promise.resolve().then(() =>
          out.type === 'writable' ? out.writable : out.acquire(request.output),
        );
        void pending.then(
          (sink) => {
            if (!active || controller.signal.aborted) void sink.abort(aborted()).catch(() => {});
          },
          () => {},
        );
        const sink = await wait(pending);
        check();
        const writer = sink.getWriter();
        writers.set(index, writer);
        void writer.closed.catch((e) => {
          if (active && !controller.signal.aborted) failSink(e);
        });
        return '';
      } catch (e) {
        if (controller.signal.aborted) throw failure ?? aborted();
        throw failSink(e);
      }
    }
    const event = request.event;
    if (event.type === 'state') {
      // Upstream completion precedes caller-owned close and is not public completion.
      if (
        !['completed', 'failed', 'cancelled'].includes(event.state) &&
        !(stopped && ['running', 'preparing', 'paused'].includes(event.state))
      )
        setState(event.state);
    } else if (event.type === 'output') {
      const output = { ...event.output };
      const writer = writers.get(output.index);
      if (writer) {
        try {
          await wait(writer.close());
          check();
          writer.releaseLock();
          writers.delete(output.index);
        } catch (e) {
          if (controller.signal.aborted) throw failure ?? aborted();
          throw failSink(e);
        }
      }
      if (paths.has(output.index)) {
        output.filePath = paths.get(output.index);
        paths.delete(output.index);
      }
      completed.push(output);
      if (completed.length > history) {
        completed.shift();
        truncated = true;
      }
      if (!controller.signal.aborted) emit({ type: 'output', output });
    } else emit(event);
    return '';
  };
  const host: HlsRecordingHost = {
    ready(value) {
      driver = value;
      ready(value);
      if (controller.signal.aborted) void value.command({ action: 'cancel' }).catch(() => {});
      else if (stopped)
        void value.command({ action: 'stop' }).catch((e) => {
          failure ??= e;
          cancel();
        });
    },
    control,
    async write(bytes, index) {
      check();
      if (options.output.type === 'blob') {
        blobBytes = bytes;
        return;
      }
      const writer = writers.get(index);
      if (!writer) throw failSink(new Error('Unknown recording output'));
      try {
        await wait(writer.write(bytes));
        check();
      } catch (e) {
        if (controller.signal.aborted) throw failure ?? aborted();
        throw failSink(e);
      }
    },
  };
  const externalAbort = () => cancel();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) cancel();
  const result = Promise.resolve().then(async () => {
    try {
      check();
      if (!Number.isSafeInteger(history) || history <= 0)
        throw new HlsDownloaderError(Code.RESOURCE_LIMIT_EXCEEDED, 'Invalid history limit');
      const { report } = await run({ ...options, operationId, signal: controller.signal }, host);
      check();
      if (writers.size) throw failSink(new Error('Unfinished recording outputs'));
      const out = options.output;
      const response = {
        operationId,
        report: {
          ...report,
          outputs: completed,
          historyTruncated: report.historyTruncated || truncated,
        },
        ...(out.type === 'blob'
          ? {
              blob: new Blob(blobBytes ? [blobBytes as Uint8Array<ArrayBuffer>] : [], {
                type: 'video/mp4',
              }),
            }
          : {}),
        ...(out.type === 'file' ? { filePath: out.path } : {}),
      };
      setState('completed');
      return response as HlsRecordingResult<O>;
    } catch (cause) {
      const error = normalizeHlsError(failure ?? cause, Code.RECORDING_FAILED);
      rejectReady(error);
      setState(error.code === Code.ABORTED ? 'cancelled' : 'failed');
      throw new HlsDownloaderError(error.code, error.message, {
        ...error,
        cause: error.cause,
        completedRecordingOutputs: [...completed],
        recordingHistoryTruncated: truncated,
      });
    } finally {
      active = false;
      controller.abort();
      options.signal?.removeEventListener('abort', externalAbort);
      for (const writer of writers.values()) {
        void writer.abort(failure ?? aborted()).catch(() => {});
        writer.releaseLock();
      }
      writers.clear();
      paths.clear();
      blobBytes = undefined;
    }
  });
  const command = async (value: Parameters<HlsRecordingDriver['command']>[0]) => {
    if (terminal() || stopped || state === 'draining' || state === 'finalizing')
      throw new HlsDownloaderError(Code.RECORDING_FAILED, 'Recording is closed', {
        reason: 'Closed',
      });
    check();
    const d = await wait(driverReady);
    check();
    try {
      await d.command(value);
    } catch (cause) {
      throw normalizeHlsError(cause, Code.RECORDING_FAILED);
    }
  };
  return {
    operationId,
    get state() {
      return state;
    },
    result,
    stop,
    cancel,
    pause: async () => {
      await command({ action: 'pause' });
      if (!stopped) setState('paused');
    },
    resume: async () => {
      await command({ action: 'resume' });
      if (!stopped) setState('running');
    },
    endInput: (inputId) => command({ action: 'end', inputId }),
    restartInput: (inputId, restart) => command({ action: 'restart', inputId, ...restart }),
  };
}

/** Initialization is shared, but an individual recording can stop waiting for it. */
export async function awaitRecordingInit(
  pending: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let abort!: () => void;
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abort = () => reject(new HlsDownloaderError(Code.ABORTED, 'Recording cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
