import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { transcodeFile } from '../packages/adapters/src/node/transcode';
import { buildFfmpegOutputArgs } from '../packages/shared/src/transcode';
import { execFileSync } from 'node:child_process';

it.each(['h264', 'hevc', 'vp9'] as const)('transcodes %s with an empty PATH', async (preset) => {
  const dir = await mkdtemp(join(tmpdir(), 'native-transcode-'));
  const previous = process.env.PATH;
  const output = join(dir, preset === 'vp9' ? 'output.webm' : 'output.mp4');
  try {
    process.env.PATH = dir;
    await transcodeFile(
      resolve(import.meta.dirname, 'fixtures/media/ts/segment-00.ts'),
      output,
      buildFfmpegOutputArgs({ preset }),
    );
    process.env.PATH = previous;
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-']);
  } finally {
    process.env.PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

it('cancels native encoding before returning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-cancel-'));
  const controller = new AbortController();
  try {
    const running = transcodeFile(
      resolve(import.meta.dirname, 'fixtures/media/ts/segment-00.ts'),
      join(dir, 'out.mp4'),
      buildFfmpegOutputArgs({ preset: 'hevc', speed: 'veryslow' }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 1);
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
