import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const mode = process.argv[2] ?? 'build-and-load';
if (!['build-only', 'build-and-load'].includes(mode)) {
  console.error(`Unsupported mode: ${mode}`);
  process.exit(1);
}

function run(command: string, args: string[], cwd = process.cwd()): void {
  const isWin = process.platform === 'win32';
  // Windows：未加 shell 时 spawn 无法可靠执行 PATH 里的 .cmd/.bat，易 ENOENT 且无输出。
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
    windowsHide: isWin,
  });
  if (result.error) {
    console.error(`[ci-native-smoke] failed to spawn ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`[ci-native-smoke] ${command} killed by signal ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0 && result.status !== null) {
    process.exit(result.status);
  }
  if (result.status === null) {
    console.error(`[ci-native-smoke] ${command} exited with unknown status (null)`);
    process.exit(1);
  }
}

const SKIP_DIRS = new Set(['target', 'node_modules', '.git', 'npm']);

function findNativeNodeFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...findNativeNodeFiles(p, base));
    } else if (e.isFile() && e.name.startsWith('native.') && e.name.endsWith('.node')) {
      out.push(relative(base, p) || e.name);
    }
  }
  return out;
}

const root = process.cwd();
const nodeDir = resolve(root, 'packages/adapters/src/node');

run('pnpm', ['--filter', '@hls-downloader/adapters', 'run', 'build:native'], root);

const nativeNodes = findNativeNodeFiles(nodeDir, nodeDir);
if (nativeNodes.length === 0) {
  console.error('No native .node artifact produced under packages/adapters/src/node (expected native.*.node).');
  try {
    const top = readdirSync(nodeDir);
    console.error(`Top-level entries in node dir (${top.length}): ${top.slice(0, 40).join(', ')}${top.length > 40 ? '…' : ''}`);
  } catch {
    /* ignore */
  }
  process.exit(1);
}

console.log(`Found native artifact(s): ${nativeNodes.join(', ')}`);

if (mode === 'build-and-load') {
  const require = createRequire(import.meta.url);
  require(resolve(nodeDir, 'native.js'));
  console.log('Native binding loaded successfully.');
} else {
  console.log('Native build-only check passed.');
}
