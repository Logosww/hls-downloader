import { HlsDownloader, NodeAdapter } from '../../dist/index.js';
import { record } from './record.ts';
import { readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [origin, size, format = 'writable'] = process.argv.slice(2);
const count = Number(size);
const dir = mkdtempSync(join(tmpdir(), 'hls-m5-'));
const samples: any[] = [];
const started = Date.now();
let committed = 0;
function sample() {
  samples.push({ elapsedMs: Date.now() - started, committed, ...process.memoryUsage() });
}
function resources() {
  return {
    descriptors: process.platform === 'win32' ? null : readdirSync('/dev/fd').length,
    active: process.getActiveResourcesInfo().sort(),
  };
}
sample();
const timer = setInterval(sample, 1000);
try {
  const downloader = new HlsDownloader({ adapter: NodeAdapter });
  const file = join(dir, 'recording.mp4');
  const result = await record(
    downloader,
    `${origin}/native/master.m3u8`,
    count,
    format === 'writable' ? undefined : { type: 'file', path: file, format },
    (n) => (committed = n),
  );
  clearInterval(timer);
  sample();
  const fileEvidence =
    format === 'writable'
      ? undefined
      : {
          bytes: statSync(file).size,
          probe: JSON.parse(
            execFileSync(
              'ffprobe',
              ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
              { encoding: 'utf8' },
            ),
          ),
        };
  if (fileEvidence)
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], {
      stdio: 'pipe',
    });
  // Warm the cancellation path before comparing resource counts.
  await record(downloader, `${origin}/warm/master.m3u8`, count, undefined, undefined, 2);
  await new Promise((r) => setTimeout(r, 1500));
  globalThis.gc?.();
  const before = resources();
  for (let i = 0; i < 8; i += 2)
    await Promise.all(
      [0, 1].map((j) =>
        record(downloader, `${origin}/cancel-${i + j}/master.m3u8`, count, undefined, undefined, 2),
      ),
    );
  await new Promise((r) => setTimeout(r, 1500));
  globalThis.gc?.();
  const after = resources();
  if (before.descriptors !== null && after.descriptors! > before.descriptors + 4)
    throw Error('Descriptors grew across cancellation');
  if (
    after.active.filter((x) => x === 'ProcessWrap').length >
    before.active.filter((x) => x === 'ProcessWrap').length
  )
    throw Error('Child process leaked');
  console.log(
    JSON.stringify({
      runtime: process.version,
      format,
      samples,
      result,
      fileEvidence,
      cleanup: { before, after, concurrentCancellations: 8 },
    }),
  );
} finally {
  clearInterval(timer);
  rmSync(dir, { recursive: true, force: true });
}
