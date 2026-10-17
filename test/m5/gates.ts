import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateMatrix } from './matrix.ts';
import { evidence, root, pnpmArgs, pnpmCommand, hash } from './harness.ts';
const { values } = parseArgs({
  options: {
    gate: { type: 'string' },
    hours: { type: 'string', default: '2' },
    smoke: { type: 'boolean' },
    out: { type: 'string' },
    'allow-dynamic': { type: 'boolean' },
    inputs: { type: 'string', multiple: true },
    help: { type: 'boolean' },
  },
});
const gates = [
  'event',
  'recovery',
  'stress',
  'classic',
  'platform',
  'candidate',
  'matrix',
  'local',
];
if (values.help || !values.gate) {
  console.log(
    'M5 gates (no publication)\n  pnpm test:m5:gates --gate ' +
      gates.join('|') +
      '\n  --hours 2 --smoke --out NEW_DIRECTORY\n  platform: --allow-dynamic (smoke only)\n  matrix: --inputs SUMMARY_JSON (repeat for all six hosts)\n  local runs event, recovery, stress and classic sequentially; default total exceeds six hours.\n  candidate requires a clean committed repository; platform requires already built artifacts.',
  );
  process.exit(0);
}
if (!gates.includes(values.gate)) throw Error('Unknown gate');
const hours = Number(values.hours);
if (!Number.isFinite(hours) || hours < 2 || hours > 24)
  throw Error('hours must be 2..24 (use --smoke for short wiring checks)');
if (values.smoke && ['candidate', 'matrix'].includes(values.gate))
  throw Error('candidate/matrix cannot be reduced to smoke');
const e = evidence(values.gate, values.out);
e.summary.config = { hours, smoke: !!values.smoke };
e.summary.qualification = values.smoke
  ? 'smoke only; no release gate closed'
  : 'selected gate only; no automatic release approval';
e.summary.sha256 = {
  'test/m5/gates.ts': hash(join(root, 'test/m5/gates.ts')),
  'test/m5/harness.ts': hash(join(root, 'test/m5/harness.ts')),
};
await e.finish(async () => {
  if (values.gate === 'matrix') {
    const summaries = (values.inputs ?? []).map((path) => ({
      path,
      sha256: hash(path),
      data: JSON.parse(readFileSync(path, 'utf8')),
    }));
    validateMatrix(summaries.map((s) => s.data));
    e.summary.platforms = summaries.map(({ path, sha256, data }) => ({
      path,
      sha256,
      target: data.target,
      commit: data.commit,
      binary: data.binary,
      tarballs: data.tarballs,
    }));
    return;
  }
  for (const gate of values.gate === 'local'
    ? ['event', 'recovery', 'stress', 'classic']
    : [values.gate!]) {
    const out = join(e.directory, gate);
    let script = gate,
      args: string[] = [];
    if (gate === 'event' || gate === 'stress') {
      script = 'soak';
      args = [
        '--playlist',
        gate === 'event' ? 'event' : 'live',
        ...(values.smoke
          ? ['--seconds', '15', '--sample-seconds', '1']
          : ['--hours', String(hours)]),
      ];
      if (gate === 'stress') args.push('--workload', 'av', '--sink-stall-ms', '500');
    } else if (gate === 'recovery')
      args = values.smoke
        ? ['--seconds', '30', '--crash-seconds', '5']
        : ['--hours', String(hours)];
    else if (gate === 'classic' && values.smoke) args = ['--segments', '32,64,128'];
    else if (gate === 'platform' && (values.smoke || values['allow-dynamic']))
      args = ['--allow-dynamic'];
    // Run via pnpm so nested package/installation commands retain a portable CLI path.
    await e.run(
      gate,
      pnpmCommand(),
      pnpmArgs([
        '--filter',
        '@hls-downloader/test',
        'exec',
        'node',
        `m5/${script}.ts`,
        ...args,
        '--out',
        out,
      ]),
      { timeoutMs: gate === 'candidate' ? 6 * 3600_000 : hours * 3600_000 + 600_000 },
    );
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    if (summary.status !== 'passed') throw Error(`${gate} exited without passed evidence`);
    e.summary.results ??= {};
    e.summary.results[gate] = {
      path: join(out, 'summary.json'),
      sha256: hash(join(out, 'summary.json')),
      qualification: summary.qualification,
    };
    e.save();
  }
});
