import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const rustDir = resolve(root, 'packages/adapters/src/rust');
const npmDir = resolve(rustDir, 'npm');
const shouldUseProvenance = process.env.GITHUB_ACTIONS === 'true';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('pnpm', ['--filter', '@hls-downloader/adapters', 'run', 'build:native'], root);
run('pnpm', ['--filter', '@hls-downloader/adapters', 'exec', 'napi', 'create-npm-dirs', '--cwd', 'src/rust'], root);
run(
  'pnpm',
  ['--filter', '@hls-downloader/adapters', 'exec', 'napi', 'artifacts', '--cwd', 'src/rust', '--output-dir', '.', '--npm-dir', 'npm'],
  root,
);
run(
  'pnpm',
  ['--filter', '@hls-downloader/adapters', 'exec', 'napi', 'pre-publish', '--cwd', 'src/rust', '--skip-optional-publish', '-t', 'npm'],
  root,
);

const platformDirs = readdirSync(npmDir)
  .map((name) => join(npmDir, name))
  .filter((p) => statSync(p).isDirectory());

let published = 0;

for (const pkgDir of platformDirs) {
  const files = readdirSync(pkgDir);
  const nodeFile = files.find((file) => file.endsWith('.node'));
  if (!nodeFile) continue;
  console.log(`Publishing ${pkgDir}`);
  const publishArgs = ['publish', '--access', 'public', '--no-git-checks'];
  if (shouldUseProvenance) {
    publishArgs.push('--provenance');
  }
  run('pnpm', publishArgs, pkgDir);
  published += 1;
}

if (published === 0) {
  console.error('No platform package with .node artifact found to publish.');
  process.exit(1);
}

console.log(`Published ${published} platform package(s).`);
