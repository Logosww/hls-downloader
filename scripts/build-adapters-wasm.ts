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
