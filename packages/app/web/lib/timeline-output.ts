import { outputFilename } from './timeline-options';

/** Reserve new entries separately so abort never removes an existing user's file. */
export function createTimelineFileOutput(options: {
  filename: string;
  signal: AbortSignal;
  directory?: FileSystemDirectoryHandle;
  fileHandle?: FileSystemFileHandle;
  reservedHandles: () => FileSystemFileHandle[];
}) {
  const created = new Map<string, string>();
  const completed = new Set<string>();
  const { directory, signal } = options;
  const removeCreated = async (index: string) => {
    const name = created.get(index);
    if (name && !completed.has(index)) await directory?.removeEntry(name).catch(() => {});
    created.delete(index);
  };
  const factory = async (output: { index: string }) => {
    try {
      signal.throwIfAborted();
      let target = options.fileHandle;
      if (directory) {
        const name = outputFilename(options.filename, output.index);
        try {
          target = await directory.getFileHandle(name);
        } catch (error) {
          if (
            !error ||
            typeof error !== 'object' ||
            !('name' in error) ||
            error.name !== 'NotFoundError'
          )
            throw error;
          signal.throwIfAborted();
          target = await directory.getFileHandle(name, { create: true });
          created.set(output.index, name);
        }
      }
      if (!target) throw new Error('保存位置已失效');
      signal.throwIfAborted();
      const collisions = await Promise.all(
        options.reservedHandles().map((existing) => target!.isSameEntry(existing)),
      );
      if (collisions.some(Boolean)) throw new Error('已有任务使用此输出文件');
      signal.throwIfAborted();
      const writable = await target.createWritable();
      if (signal.aborted) {
        await writable.abort().catch(() => {});
        signal.throwIfAborted();
      }
      return writable;
    } catch (error) {
      // A factory may settle after SDK cancellation and the outer cleanup Promise.
      if (signal.aborted) await removeCreated(output.index);
      throw error;
    }
  };
  return {
    factory,
    complete(outputs: readonly { index: string }[]) {
      outputs.forEach((output) => completed.add(output.index));
    },
    async cleanup() {
      await Promise.allSettled(
        [...created.keys()].filter((index) => !completed.has(index)).map(removeCreated),
      );
    },
  };
}
