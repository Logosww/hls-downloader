import { fork } from 'node:child_process';
import { parseArgs } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evidence, root, hash } from './harness.ts';
import { startSource } from './source.ts';
import { realtimeWindow } from './realtime.ts';
const { values } = parseArgs({
  options: {
    hours: { type: 'string', default: '2' },
    seconds: { type: 'string' },
    'crash-seconds': { type: 'string', default: '300' },
    out: { type: 'string' },
  },
});
const durationMs = Number(values.seconds ?? Number(values.hours) * 3600) * 1000;
const crashMs = Number(values['crash-seconds']) * 1000;
if (
  !Number.isFinite(durationMs) ||
  durationMs < 15_000 ||
  durationMs > 86400_000 ||
  !Number.isFinite(crashMs) ||
  crashMs < 3000 ||
  crashMs > durationMs / 3
)
  throw Error('Require duration 15s..24h and crash interval 3s..duration/3');
const e = evidence('recovery', values.out);
e.summary.config = { durationMs, crashMs, mode: 'live', failEvery: 29 };
e.summary.qualification =
  values.seconds === undefined && durationMs >= 7200_000
    ? 'multi-hour recovery and faults'
    : 'smoke only';
e.summary.sha256 = Object.fromEntries(
  [
    'test/m5/recovery.ts',
    'test/m5/recovery-worker.ts',
    'test/m5/source.ts',
    'dist/index.js',
    'packages/adapters/dist/node.mjs',
    ...readdirSync(join(root, 'packages/adapters/dist'))
      .filter((f) => f.endsWith('.node'))
      .map((f) => 'packages/adapters/dist/' + f),
  ].map((f) => [f, hash(join(root, f))]),
);
let lastSample: any;
async function worker(
  directory: string,
  url: string,
  crash: boolean,
  budget?: number,
  rotating = true,
) {
  let result: any,
    killed = false;
  const started = performance.now();
  const child = fork(
    join(import.meta.dirname, 'recovery-worker.ts'),
    [JSON.stringify({ directory, url, budget, rotating })],
    { cwd: directory, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  child.stderr!.on('data', (bytes) =>
    appendFileSync(join(e.directory, 'worker.stderr.log'), bytes),
  );
  let lastMessage = performance.now();
  let lastProgress = lastMessage,
    previousCommitted = -1;
  const timer = setInterval(() => {
    if (
      performance.now() - lastMessage > 60_000 ||
      performance.now() - lastProgress > 60_000 ||
      performance.now() - started > (budget ? 180_000 : durationMs + 120_000) ||
      e.signal.aborted
    )
      child.kill('SIGKILL');
  }, 1000);
  try {
    return await new Promise<any>((accept, reject) => {
      child.on('message', (message: any) => {
        lastMessage = performance.now();
        if (message.type === 'sample') {
          if (message.committed > previousCommitted) {
            previousCommitted = message.committed;
            lastProgress = performance.now();
          }
          lastSample = message;
          appendFileSync(
            join(e.directory, 'samples.ndjson'),
            JSON.stringify({ at: new Date().toISOString(), pid: child.pid, ...message }) + '\n',
          );
          if (message.journalBytes > (budget ?? 2 * 1024 ** 2)) {
            child.kill('SIGKILL');
            result = { type: 'error', error: 'Recovery journal exceeded budget' };
          }
          if (crash && !killed && message.committed > 0 && performance.now() - started >= crashMs) {
            killed = true;
            child.kill('SIGKILL');
          }
        } else result = message;
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (e.signal.aborted) reject(e.signal.reason);
        else if (killed && !result)
          accept({ killed: true, signal, committed: lastSample.committed });
        else if (code === 0 && ['result', 'budget'].includes(result?.type)) accept(result);
        else reject(Error(`Recovery worker ${code}/${signal}: ${JSON.stringify(result)}`));
      });
    });
  } finally {
    clearInterval(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
await e.finish(async () => {
  const count = realtimeWindow(0, durationMs, 'live').count;
  const source = await startSource(
    count,
    16,
    undefined,
    { durationMs, mode: 'live' },
    { failEvery: 29 },
  );
  const directory = join(e.directory, 'recording');
  mkdirSync(directory);
  let final: any;
  e.summary.crashes = [];
  const started = performance.now();
  try {
    while (!final) {
      if (performance.now() - started > durationMs + 120_000)
        throw Error('Recovery deadline exceeded');
      const result = await worker(
        directory,
        source.origin + '/recovery/master.m3u8',
        performance.now() - started < durationMs - crashMs * 2,
      );
      if (result.killed) e.summary.crashes.push(result);
      else final = result;
      e.save();
    }
    if (e.summary.crashes.length < 2 || !source.failures)
      throw Error('Crash/network injection did not execute');
    if (
      final.report.endReason !== 'Eof' ||
      final.report.inputs.find((i: any) => i.inputId === 'primary')?.committed !== String(count)
    )
      throw Error('Recovered media is incomplete');
    e.summary.final = {
      count,
      endReason: final.report.endReason,
      networkFailures: source.failures,
    };
  } finally {
    await source.close();
  }
  const before = hash(join(directory, 'recording.mp4'));
  await worker(directory, source.origin + '/recovery/master.m3u8', false); // Server is closed: terminal resume must be offline.
  if (hash(join(directory, 'recording.mp4')) !== before)
    throw Error('Offline resume changed output');
  const cues = readFileSync(join(directory, 'recording.vtt'), 'utf8').match(/^cue-\d+$/gm) ?? [];
  if (
    cues.length !== count ||
    new Set(cues).size !== count ||
    !cues.every((c, i) => c === `cue-${i}`)
  )
    throw Error('Recovered subtitle cues are missing, duplicated or reordered');
  await e.run('decode', 'ffmpeg', [
    '-v',
    'error',
    '-xerror',
    '-i',
    join(directory, 'recording.mp4'),
    '-f',
    'null',
    '-',
  ]);
  await e.run('frames', 'ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=nb_read_frames',
    '-of',
    'json',
    join(directory, 'recording.mp4'),
  ]);
  const probe = JSON.parse(readFileSync(join(e.directory, '2-frames.log'), 'utf8'));
  if (Number(probe.streams[0].nb_read_frames) !== count * 17)
    throw Error('Recovered AAC frame count differs from source');
  const checkpoint = JSON.parse(
    readFileSync(join(directory, 'checkpoint/engine-state.json'), 'utf8'),
  );
  if (
    checkpoint.journal.length ||
    readdirSync(directory).some(
      (f) => !['checkpoint', 'recording.mp4', 'recording.vtt'].includes(f),
    )
  )
    throw Error('Terminal recovery cleanup incomplete');
  e.summary.output = {
    sha256: before,
    bytes: statSync(join(directory, 'recording.mp4')).size,
    cues: cues.length,
    offlineResume: true,
  };
  const limited = await startSource(512, 16, undefined, undefined, { cumulative: true });
  const limitedDir = join(e.directory, 'budget');
  mkdirSync(limitedDir);
  try {
    const result = await worker(
      limitedDir,
      limited.origin + '/budget/master.m3u8',
      false,
      64 * 1024,
      false,
    );
    if (result.type !== 'budget') throw Error('Expected explicit recovery budget exhaustion');
    e.summary.budget = { ...result, sample: lastSample };
  } finally {
    await limited.close();
  }
});
