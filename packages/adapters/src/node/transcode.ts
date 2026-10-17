import { spawn } from 'node:child_process';
import { HlsDownloaderError, HlsDownloaderErrorCode as Code } from '@hls-downloader/shared';
import { assertActive } from '../browser/request';

/** Input is local clear Engine output; FFmpeg never fetches media or resolves keys. */
export async function transcodeFile(
  input: string,
  output: string,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  assertActive(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-n',
        '-copyts',
        '-start_at_zero',
        '-i',
        input,
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-fps_mode',
        'passthrough',
        ...args,
        output,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-8192);
    });
    child.once('error', (cause) => {
      cleanup();
      reject(new HlsDownloaderError(Code.TRANSCODE_FAILED, 'Cannot start FFmpeg', { cause }));
    });
    child.once('close', (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(new HlsDownloaderError(Code.ABORTED, 'Transcoding aborted'));
      } else if (code !== 0) {
        reject(
          new HlsDownloaderError(Code.TRANSCODE_FAILED, 'FFmpeg transcoding failed', {
            reason: 'FfmpegExit',
            cause: new Error(stderr),
          }),
        );
      } else resolve();
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  assertActive(signal);
}
