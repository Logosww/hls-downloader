import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type HlsMultiTrackOptions,
} from '@hls-downloader/shared';
import { cancellable } from './browser/request';

/** One owned writer per current track/output; close on output advance, not at
 * recording end. A blocked write is interruptible even when the sink ignores abort. */
export function createSidecars(options: HlsMultiTrackOptions, native: boolean) {
  const selections = new Map((options.subtitleTracks ?? []).map((t) => [t.id, t]));
  const writers = new Map<
    string,
    { index: string; writer: WritableStreamDefaultWriter<Uint8Array> }
  >();
  const borrowed = new Set<WritableStream<Uint8Array>>();
  const encoder = new TextEncoder();
  let ended = false;
  const split = options.timeline?.changePolicy === 'split' || options.missingSegments === 'split';
  for (const t of selections.values()) {
    if (t.embedded !== undefined && typeof t.embedded !== 'boolean')
      throw new HlsDownloaderError(Code.UNSUPPORTED_RENDITION, 'Invalid embedded subtitle option');
    if (t.embedded === false && !t.sidecar)
      throw new HlsDownloaderError(
        Code.UNSUPPORTED_OUTPUT,
        'Non-embedded subtitle requires a sidecar',
      );
    const s = t.sidecar;
    if (!s) continue;
    if (!['writable', 'writables', 'file'].includes(s.type))
      throw new HlsDownloaderError(Code.UNSUPPORTED_OUTPUT, 'Unknown subtitle output');
    if (
      s.type === 'file' &&
      (!native || options.output.type !== 'file' || typeof s.path !== 'string' || !s.path)
    )
      throw new HlsDownloaderError(
        Code.UNSUPPORTED_OUTPUT,
        'Subtitle files require native fixed media output',
      );
    if (
      s.type === 'writable' &&
      (split ||
        !s.writable ||
        s.writable.locked ||
        borrowed.has(s.writable) ||
        (options.output.type === 'writable' && options.output.writable === s.writable))
    )
      throw new HlsDownloaderError(
        Code.UNSUPPORTED_OUTPUT,
        'Subtitle Writable must be distinct, unlocked and cannot split',
      );
    if (s.type === 'writables' && typeof s.acquire !== 'function')
      throw new HlsDownloaderError(Code.UNSUPPORTED_OUTPUT, 'Subtitle factory required');
    if (s.type === 'writable') borrowed.add(s.writable);
  }
  if (
    options.resume &&
    [...selections.values()].some((t) => t.sidecar) &&
    [...selections.values()].some((t) => t.sidecar?.type !== 'file')
  )
    throw new HlsDownloaderError(
      Code.UNSUPPORTED_OUTPUT,
      'Subtitle recovery requires a fixed file for every subtitle track',
    );
  const close = async (id: string) => {
    const entry = writers.get(id);
    if (!entry) return;
    await cancellable(entry.writer.close(), options.signal);
    entry.writer.releaseLock();
    writers.delete(id);
  };
  return {
    wire(id: string) {
      const s = selections.get(id)?.sidecar;
      return s && (s.type === 'file' ? { type: s.type, path: s.path } : { type: s.type });
    },
    async control(r: any) {
      if (ended) throw new HlsDownloaderError(Code.ABORTED, 'Subtitle output ended');
      try {
        if (r.action === 'subtitleFinish') {
          for (const id of writers.keys()) await close(id);
          ended = true;
          return '';
        }
        for (const chunk of r.chunks) {
          const output = selections.get(chunk.inputId)?.sidecar;
          if (!output || output.type === 'file') continue;
          let entry = writers.get(chunk.inputId);
          if (entry && entry.index !== chunk.outputIndex) {
            await close(chunk.inputId);
            entry = undefined;
          }
          if (!entry) {
            const pending = Promise.resolve().then(() =>
              output.type === 'writable'
                ? output.writable
                : output.acquire({ inputId: chunk.inputId, outputIndex: chunk.outputIndex }),
            );
            void pending.then(
              (stream) => {
                if (ended || options.signal?.aborted)
                  void stream
                    .abort(new HlsDownloaderError(Code.ABORTED, 'Subtitle output ended'))
                    .catch(() => {});
              },
              () => {},
            );
            const stream = await cancellable(pending, options.signal);
            if (ended || options.signal?.aborted)
              throw new HlsDownloaderError(Code.ABORTED, 'Subtitle output ended');
            if (stream.locked)
              throw new HlsDownloaderError(
                Code.UNSUPPORTED_OUTPUT,
                'Subtitle writer is already owned',
              );
            entry = { index: chunk.outputIndex, writer: stream.getWriter() };
            writers.set(chunk.inputId, entry);
            void entry.writer.closed.catch(() => {});
            await cancellable(entry.writer.write(encoder.encode('WEBVTT\n\n')), options.signal);
          }
          if (chunk.text)
            await cancellable(entry.writer.write(encoder.encode(chunk.text)), options.signal);
        }
        return '';
      } catch (cause) {
        if (cause instanceof HlsDownloaderError) throw cause;
        throw new HlsDownloaderError(
          Code.OUTPUT_WRITE_FAILED,
          'Subtitle output write or close failed',
          { cause },
        );
      }
    },
    abort(cause: unknown) {
      ended = true;
      for (const { writer } of writers.values()) {
        void writer.abort(cause).catch(() => {});
        // Releasing a lock does not wait for an uncooperative underlying write.
        writer.releaseLock();
      }
      writers.clear();
    },
  };
}
