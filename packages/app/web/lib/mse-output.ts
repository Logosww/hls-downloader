/** Resolve each write after MSE consumes it, keeping only one append in flight. */
export function createMseWritable(
  mediaSource: MediaSource,
  buffer: SourceBuffer,
  signal: AbortSignal,
): WritableStream<Uint8Array> {
  return new WritableStream({
    write(bytes) {
      signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          buffer.removeEventListener('updateend', done);
          buffer.removeEventListener('error', failed);
          buffer.removeEventListener('abort', failed);
          signal.removeEventListener('abort', cancelled);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new Error('MSE append failed'));
        };
        const cancelled = () => {
          cleanup();
          reject(signal.reason);
        };
        buffer.addEventListener('updateend', done, { once: true });
        buffer.addEventListener('error', failed, { once: true });
        buffer.addEventListener('abort', failed, { once: true });
        signal.addEventListener('abort', cancelled, { once: true });
        try {
          buffer.appendBuffer(bytes.slice().buffer);
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
    },
    close() {
      signal.throwIfAborted();
      if (mediaSource.readyState === 'open') mediaSource.endOfStream();
    },
  });
}
