import { HlsDownloaderError, HlsDownloaderErrorCode as Code } from '@hls-downloader/shared';
import { assertActive } from '../browser/request';
import { cancelJob, createCancelToken, transcodeFileNative } from './native.js';

/** Transcode local clear Engine output using the linked native FFmpeg libraries. */
export async function transcodeFile(
  input: string,
  output: string,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  assertActive(signal);
  const job = createCancelToken();
  const abort = () => cancelJob(job);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    assertActive(signal);
    await transcodeFileNative(input, output, args, job);
    assertActive(signal);
  } catch (cause) {
    assertActive(signal);
    throw new HlsDownloaderError(Code.TRANSCODE_FAILED, 'Native FFmpeg transcoding failed', {
      cause,
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    cancelJob(job);
  }
}
