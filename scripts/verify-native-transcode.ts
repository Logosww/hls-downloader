import { createRequire } from 'node:module';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const native = require('../packages/adapters/src/node/native.js');
const directory = await mkdtemp(join(tmpdir(), 'native-ffmpeg-'));
const previousPath = process.env.PATH;
const input = fileURLToPath(new URL('../test/fixtures/media/ts/segment-00.ts', import.meta.url));
try {
  process.env.PATH = directory;
  for (const [video, audio, format] of [
    ['libx264', 'aac', 'mp4'],
    ['libx265', 'aac', 'mp4'],
    ['libvpx-vp9', 'libopus', 'webm'],
  ]) {
    const output = join(directory, `${video}.${format}`);
    const job = native.createCancelToken();
    try {
      await native.transcodeFileNative(
        input,
        output,
        ['-c:v', video, '-c:a', audio, '-f', format],
        job,
      );
      if ((await stat(output)).size === 0) throw new Error(`Empty ${video} output`);
    } finally {
      native.cancelJob(job);
    }
  }
  console.log('Native h264/hevc/vp9 transcoding passed with no FFmpeg executable on PATH');
} finally {
  process.env.PATH = previousPath;
  await rm(directory, { recursive: true, force: true });
}
