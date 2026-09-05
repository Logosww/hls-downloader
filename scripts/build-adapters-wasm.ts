import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const browserRoot = join(repoRoot, 'packages', 'adapters', 'src', 'browser');
const crateRoot = join(browserRoot, 'crates', 'hls-transmux-wasm');
const targetRoot = join(crateRoot, 'target');
const outputRoot = join(browserRoot, 'generated');
const environment = {
  ...process.env,
  CARGO_TARGET_DIR: targetRoot,
  PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH ?? ''}`,
};

const shell = process.platform === 'win32';
const cargoCheck = spawnSync('cargo', ['--version'], {
  env: environment,
  stdio: 'pipe',
  shell,
});
if (cargoCheck.error || cargoCheck.status !== 0) {
  console.error('[adapters] cargo is required to generate the browser WASM artifacts');
  process.exit(1);
}

const bindgenCheck = spawnSync('wasm-bindgen', ['--version'], {
  env: environment,
  stdio: 'pipe',
  shell,
});
if (bindgenCheck.error || bindgenCheck.status !== 0) {
  console.error('[adapters] wasm-bindgen is required to generate the browser WASM artifacts');
  process.exit(1);
}

mkdirSync(outputRoot, { recursive: true });

const build = spawnSync('cargo', ['build', '--target', 'wasm32-unknown-unknown', '--release'], {
  cwd: crateRoot,
  env: environment,
  stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const wasmPath = join(
  targetRoot,
  'wasm32-unknown-unknown',
  'release',
  'hls_transmux_browser_wasm.wasm',
);
const bindgen = spawnSync(
  'wasm-bindgen',
  [wasmPath, '--out-dir', outputRoot, '--target', 'web', '--out-name', 'hls_transmux_browser_wasm'],
  { env: environment, stdio: 'inherit' },
);
if (bindgen.status !== 0) process.exit(bindgen.status ?? 1);
