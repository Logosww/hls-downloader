import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { evidence, root, pnpmArgs, pnpmCommand } from './harness.ts';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const e = evidence('candidate', values.out);
e.summary.qualification =
  'clean committed candidate on this host; platform matrix and long-run evidence remain separate';
await e.finish(async () => {
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (dirty)
    throw Error(
      'Final candidate requires a clean committed checkout, including the M5 scripts. Commit/review outstanding changes first; this script never commits or discards them.',
    );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  e.summary.commit = commit;
  const checkout = join(e.directory, 'checkout');
  await e.run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', root, checkout]);
  await e.run('checkout', 'git', ['checkout', '--detach', commit], { cwd: checkout });
  const pnpm = (name: string, args: string[], timeoutMs = 900_000, env?: NodeJS.ProcessEnv) =>
    e.run(name, pnpmCommand(), pnpmArgs(args), { cwd: checkout, timeoutMs, env });
  await pnpm('install', ['install', '--frozen-lockfile'], 1200_000);
  await pnpm('build', ['run', 'build'], 7200_000, { TURBO_FORCE: 'true' });
  await pnpm(
    'sdk',
    [
      '--filter',
      '@hls-downloader/test',
      'exec',
      'vitest',
      'run',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${join(e.directory, 'vitest.json')}`,
    ],
    1800_000,
    { HLS_DOWNLOADER_TEST_PUBLISH_ENTRYPOINTS: '1', HLS_PLAYER_FIXTURES: '1' },
  );
  const results = JSON.parse(readFileSync(join(e.directory, 'vitest.json'), 'utf8'));
  e.summary.tests = {
    passed: results.numPassedTests,
    failed: results.numFailedTests,
    pending: results.numPendingTests,
    todo: results.numTodoTests,
  };
  if (
    !results.numPassedTests ||
    results.numFailedTests ||
    results.numPendingTests ||
    results.numTodoTests
  )
    throw Error('Candidate suite contains failed, skipped or todo tests; inspect vitest.json');
  await pnpm('rust', ['--filter', '@hls-downloader/test', 'run', 'test:native:resume'], 1800_000);
  await pnpm(
    'chromium',
    ['--filter', '@hls-downloader/test', 'exec', 'playwright', 'install', 'chromium'],
    1200_000,
  );
  for (const script of [
    'test:browser:engine',
    'test:browser:recording',
    'test:browser:multitrack',
    'test:browser:subtitles',
    'test:browser:transcode',
    'test:players:browser',
  ]) {
    await pnpm(
      script.replaceAll(':', '-'),
      ['--filter', '@hls-downloader/test', 'run', script],
      900_000,
    );
  }
  await e.run('bun', 'bun', ['test', 'packages/app/bun'], { cwd: checkout, timeoutMs: 600_000 });
  await e.run('players', 'python3', ['test/players/verify.py'], { cwd: checkout });
});
