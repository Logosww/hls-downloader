import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type HlsCompletedOutput,
  type HlsOutputControl,
  type HlsOutputFactory,
} from '@hls-downloader/shared';
/** Owns only acquired writers. The engine owns media flush; this host owns close. */
export function createOutputManager(
  factory: HlsOutputFactory,
  signal: AbortSignal,
  onFailure: () => void,
) {
  const writers = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();
  const completed: HlsCompletedOutput[] = [];
  const bytes = new Map<string, bigint>();
  let active = true;
  let firstError: unknown;
  const cancelled = () => new HlsDownloaderError(Code.ABORTED, 'Operation aborted');
  const check = () => {
    if (firstError) throw firstError;
    if (!active || signal.aborted) throw cancelled();
  };
  const wait = async <T>(p: Promise<T>): Promise<T> => {
    let listener: () => void = () => {};
    const abort = new Promise<never>((_, reject) => {
      listener = () => reject(cancelled());
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    });
    try {
      return await Promise.race([p, abort]);
    } finally {
      signal.removeEventListener('abort', listener);
    }
  };
  const fail = (cause: unknown) => {
    if (cause instanceof HlsDownloaderError && cause.code === Code.ABORTED) return cause;
    return new HlsDownloaderError(Code.OUTPUT_WRITE_FAILED, 'Output sink failed', {
      cause,
      completedOutputs: [...completed],
    });
  };
  const control: HlsOutputControl = async (r) => {
    check();
    const index = r.output.index;
    try {
      if (r.action === 'acquire') {
        if (writers.has(index) || completed.some((o) => o.index === index))
          throw new Error('Output already acquired');
        // Observe late factories and release their sinks even after cancellation.
        const pending = Promise.resolve().then(() => factory(r.output));
        void pending.then(
          (s) => {
            if (!active || signal.aborted) void s.abort(cancelled()).catch(() => {});
          },
          () => {},
        );
        const sink = await wait(pending);
        check();
        const writer = sink.getWriter();
        writers.set(index, writer);
        bytes.set(index, 0n);
        void writer.closed.catch((cause) => {
          if (active && !signal.aborted) {
            firstError ??= fail(cause);
            onFailure();
          }
        });
      } else {
        const writer = writers.get(index);
        if (!writer) throw new Error('Unknown output');
        await wait(writer.close());
        check();
        completed.push({ ...r.output, bytesWritten: (bytes.get(index) ?? 0n).toString() });
        writer.releaseLock();
        writers.delete(index);
      }
      return '';
    } catch (cause) {
      const error = fail(cause);
      firstError ??= error;
      throw error;
    }
  };
  const write = async (chunk: Uint8Array, index: string) => {
    check();
    const writer = writers.get(index);
    if (!writer) throw fail(new Error('Unknown output'));
    try {
      await wait(writer.write(chunk));
      check();
      bytes.set(index, (bytes.get(index) ?? 0n) + BigInt(chunk.byteLength));
    } catch (cause) {
      const error = fail(cause);
      firstError ??= error;
      throw error;
    }
  };
  return {
    control,
    write,
    completed,
    error(cause: unknown) {
      const e = firstError ?? cause;
      return e instanceof HlsDownloaderError
        ? new HlsDownloaderError(e.code, e.message, {
            ...e,
            cause: e.cause,
            completedOutputs: [...completed],
          })
        : new HlsDownloaderError(Code.TIMELINE_FAILED, 'Timeline processing failed', {
            cause: e,
            completedOutputs: [...completed],
          });
    },
    dispose(reason?: unknown) {
      active = false;
      for (const w of writers.values()) {
        void w.abort(reason).catch(() => {});
        w.releaseLock();
      }
      writers.clear();
    },
  };
}
