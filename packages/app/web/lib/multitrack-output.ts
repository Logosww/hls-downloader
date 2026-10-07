import { HlsDownloaderError, HlsDownloaderErrorCode } from '@hls-downloader/shared';
import { outputFilename } from './timeline-options';

/** Closed outputs remain available on failure; one budget covers every retained byte. */
export function createMultiTrackMemoryOutput(filename: string, maxBytes: number) {
  const outputs: { index: string; title: string; blobURL: string; saved: false }[] = [];
  let bytes = 0;
  return {
    outputs,
    async acquire({ index }: { index: string }) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let pendingBytes = 0;
      return new WritableStream<Uint8Array>({
        write(chunk) {
          if (chunk.byteLength > maxBytes - bytes)
            throw new HlsDownloaderError(
              HlsDownloaderErrorCode.RESOURCE_LIMIT_EXCEEDED,
              'Multi-track output exceeds memory capacity',
              { reason: 'OutputCapacity' },
            );
          chunks.push(new Uint8Array(chunk));
          bytes += chunk.byteLength;
          pendingBytes += chunk.byteLength;
        },
        close() {
          const blobURL = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
          chunks.length = 0;
          outputs.push({ index, title: outputFilename(filename, index), blobURL, saved: false });
        },
        abort() {
          chunks.length = 0;
          bytes -= pendingBytes;
          pendingBytes = 0;
        },
      });
    },
    revoke() {
      for (const output of outputs) URL.revokeObjectURL(output.blobURL);
    },
  };
}
