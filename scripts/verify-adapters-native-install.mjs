import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const rustDir = resolve(root, 'packages/adapters/src/rust');
const adaptersDir = resolve(root, 'packages/adapters');
const coreDir = resolve(root, 'packages/core');
const sharedDir = resolve(root, 'packages/shared');
const npmDir = resolve(rustDir, 'npm');
const tempRoot = mkdtempSync(join(tmpdir(), 'hls-adapters-verify-'));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}`);
  }
}

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}`);
  }
  return result.stdout.trim();
}

function normalizePackedTarPath(packOutput, tarDir) {
  const packed = packOutput.split('\n').pop().trim();
  if (packed.startsWith('/')) return packed;
  return join(tarDir, packed);
}

try {
  run('pnpm', ['--filter', '@hls-downloader/shared', 'run', 'build'], root);
  run('pnpm', ['--filter', '@hls-downloader/core', 'run', 'build'], root);
  run('pnpm', ['--filter', '@hls-downloader/adapters', 'run', 'build:publish'], root);
  run('pnpm', ['run', 'build:root'], root);
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

  let currentPlatformPackageDir = '';
  for (const dir of platformDirs) {
    const files = readdirSync(dir);
    if (files.some((f) => f.endsWith('.node'))) {
      currentPlatformPackageDir = dir;
      break;
    }
  }

  if (!currentPlatformPackageDir) {
    throw new Error('No current-platform native package produced; cannot verify install flow.');
  }

  const platformTarDir = join(tempRoot, 'tarballs');
  const platformTarPath = normalizePackedTarPath(
    runCapture('pnpm', ['pack', '--pack-destination', platformTarDir], currentPlatformPackageDir),
    platformTarDir,
  );

  const adaptersTempDir = join(tempRoot, 'adapters-pkg');
  cpSync(adaptersDir, adaptersTempDir, { recursive: true });
  const adaptersPkgPath = join(adaptersTempDir, 'package.json');
  const adaptersPkg = JSON.parse(readFileSync(adaptersPkgPath, 'utf8'));
  const platformPkgName = JSON.parse(readFileSync(join(currentPlatformPackageDir, 'package.json'), 'utf8')).name;
  for (const [name, spec] of Object.entries(adaptersPkg.dependencies ?? {})) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) {
      adaptersPkg.dependencies[name] = adaptersPkg.version;
    }
  }
  adaptersPkg.optionalDependencies = {
    [platformPkgName]: `file:${platformTarPath}`,
  };
  writeFileSync(adaptersPkgPath, `${JSON.stringify(adaptersPkg, null, 2)}\n`, 'utf8');

  const adaptersTarDir = join(tempRoot, 'adapters-tar');
  const adaptersTarPath = normalizePackedTarPath(
    runCapture('pnpm', ['pack', '--pack-destination', adaptersTarDir], adaptersTempDir),
    adaptersTarDir,
  );

  const sharedTarDir = join(tempRoot, 'shared-tar');
  const sharedTarPath = normalizePackedTarPath(
    runCapture('pnpm', ['pack', '--pack-destination', sharedTarDir], sharedDir),
    sharedTarDir,
  );

  const coreTarDir = join(tempRoot, 'core-tar');
  const coreTarPath = normalizePackedTarPath(
    runCapture('pnpm', ['pack', '--pack-destination', coreTarDir], coreDir),
    coreTarDir,
  );

  const consumerDir = join(tempRoot, 'consumer');
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({ name: 'adapters-native-verify', private: true, type: 'module' }, null, 2),
  );
  run('pnpm', ['add', adaptersTarPath], consumerDir);

  const checkScript = `
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
const adaptersPath = new URL('./node_modules/@hls-downloader/adapters/dist/', import.meta.url);
const distFiles = readdirSync(adaptersPath);
if (distFiles.some((f) => f.endsWith('.node'))) {
  throw new Error('adapters dist should not contain .node files');
}
await import('@hls-downloader/adapters/rust');
console.log('OK: adapters installs without bundled .node and rust adapter imports successfully.');
`;
  writeFileSync(join(consumerDir, 'verify.mjs'), checkScript, 'utf8');
  run('node', ['verify.mjs'], consumerDir);

  const rootPkgPath = resolve(root, 'package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  rootPkg.dependencies = {
    '@hls-downloader/adapters': `file:${adaptersTarPath}`,
    '@hls-downloader/core': `file:${coreTarPath}`,
    '@hls-downloader/shared': `file:${sharedTarPath}`,
  };
  delete rootPkg.workspaces;
  delete rootPkg.devDependencies;

  const rootTempDir = join(tempRoot, 'root-pkg');
  mkdirSync(rootTempDir, { recursive: true });
  cpSync(resolve(root, 'dist'), join(rootTempDir, 'dist'), { recursive: true });
  cpSync(resolve(root, 'LICENSE'), join(rootTempDir, 'LICENSE'));
  writeFileSync(join(rootTempDir, 'package.json'), `${JSON.stringify(rootPkg, null, 2)}\n`, 'utf8');

  const rootTarDir = join(tempRoot, 'root-tar');
  const rootTarPath = normalizePackedTarPath(
    runCapture('pnpm', ['pack', '--pack-destination', rootTarDir], rootTempDir),
    rootTarDir,
  );

  const aggregateConsumerDir = join(tempRoot, 'aggregate-consumer');
  mkdirSync(aggregateConsumerDir, { recursive: true });
  writeFileSync(
    join(aggregateConsumerDir, 'package.json'),
    JSON.stringify({ name: 'aggregate-native-verify', private: true, type: 'module' }, null, 2),
  );
  run('pnpm', ['add', rootTarPath], aggregateConsumerDir);

  const aggregateCheckScript = `
await import('@logosw/hls-downloader/adapters/rust');
console.log('OK: aggregate package installs and loads rust adapter via platform package.');
`;
  writeFileSync(join(aggregateConsumerDir, 'verify.mjs'), aggregateCheckScript, 'utf8');
  run('node', ['verify.mjs'], aggregateConsumerDir);

  console.log(`Verification workspace: ${tempRoot}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  // Keep temp dir only on failure for debugging.
  if (process.exitCode === undefined || process.exitCode === 0) {
    rmSync(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`Temp files kept at: ${tempRoot}`);
  }
}
