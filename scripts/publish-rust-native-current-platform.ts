import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const adaptersPkgPath = resolve(root, 'packages/adapters/package.json');
const rustDir = resolve(root, 'packages/adapters/src/rust');
const npmDir = resolve(rustDir, 'npm');
const shouldUseProvenance = process.env.GITHUB_ACTIONS === 'true';

function adaptersVersionIsPrerelease(): boolean {
  const pkg = JSON.parse(readFileSync(adaptersPkgPath, 'utf8')) as { version?: string };
  return Boolean(pkg.version?.includes('-'));
}

function run(command: string, args: string[], cwd: string): void {
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
const prerelease = adaptersVersionIsPrerelease();
if (prerelease) {
  console.log('Prerelease adapters version: publishing with dist-tag "next"');
}

for (const pkgDir of platformDirs) {
  const files = readdirSync(pkgDir);
  const nodeFile = files.find((file) => file.endsWith('.node'));
  if (!nodeFile) continue;
  console.log(`Publishing ${pkgDir}`);
  const publishArgs = ['publish', '--access', 'public', '--no-git-checks'];
  if (shouldUseProvenance) {
    publishArgs.push('--provenance');
  }
  if (prerelease) {
    publishArgs.push('--tag', 'next');
  }
  run('pnpm', publishArgs, pkgDir);
  published += 1;
}

if (published === 0) {
  console.error('No platform package with .node artifact found to publish.');
  process.exit(1);
}

console.log(`Published ${published} platform package(s).`);
