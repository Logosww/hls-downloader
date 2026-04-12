import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const mode = process.argv[2] ?? 'build-and-load';
if (!['build-only', 'build-and-load'].includes(mode)) {
  console.error(`Unsupported mode: ${mode}`);
  process.exit(1);
}

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const root = process.cwd();
const rustDir = resolve(root, 'packages/adapters/src/rust');

run('pnpm', ['--filter', '@hls-downloader/adapters', 'run', 'build:native'], root);

const nativeNodes = readdirSync(rustDir).filter((f) => f.startsWith('native.') && f.endsWith('.node'));
if (nativeNodes.length === 0) {
  console.error('No native .node artifact produced in adapters rust directory.');
  process.exit(1);
}

if (mode === 'build-and-load') {
  const require = createRequire(import.meta.url);
  require(resolve(rustDir, 'native.js'));
  console.log('Native binding loaded successfully.');
} else {
  console.log('Native build-only check passed.');
}
