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

// 远程构建环境(如 Vercel)无 Rust 工具链时跳过;
// wasm 产物(hls_transmux_browser_wasm_bg.wasm)由本地预编译,通过 .vercelignore 强制上传。
const shell = process.platform === 'win32';
const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'pipe', shell });
if (cargoCheck.error || cargoCheck.status !== 0) {
  console.warn('[adapters] cargo not found, skipping wasm build (using prebuilt artifacts)');
  process.exit(0);
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
