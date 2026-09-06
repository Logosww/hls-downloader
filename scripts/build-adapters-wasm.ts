import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const browserRoot = join(repoRoot, 'packages', 'adapters', 'src', 'browser');
const crateRoot = join(browserRoot, 'crates', 'hls-transmux-wasm');
const targetRoot = join(crateRoot, 'target');
const outputRoot = join(browserRoot, 'generated');
const generatedArtifacts = [
  join(outputRoot, 'hls_transmux_browser_wasm.js'),
  join(outputRoot, 'hls_transmux_browser_wasm.d.ts'),
  join(outputRoot, 'hls_transmux_browser_wasm_bg.wasm'),
  join(outputRoot, 'hls_transmux_browser_wasm_bg.wasm.d.ts'),
];
const environment = {
  ...process.env,
  CARGO_TARGET_DIR: targetRoot,
};

const shell = process.platform === 'win32';
const cargoCheck = spawnSync('cargo', ['--version'], {
  env: environment,
  stdio: 'pipe',
  shell,
});
if (cargoCheck.error || cargoCheck.status !== 0) {
  usePrebuiltArtifactsOrExit('cargo');
}

const bindgenCheck = spawnSync('wasm-bindgen', ['--version'], {
  env: environment,
  stdio: 'pipe',
  shell,
});
if (bindgenCheck.error || bindgenCheck.status !== 0) {
  usePrebuiltArtifactsOrExit('wasm-bindgen');
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

function usePrebuiltArtifactsOrExit(missingTool: string): never {
  const missingArtifacts = generatedArtifacts.filter((artifact) => !existsSync(artifact));
  if (missingArtifacts.length === 0) {
    console.warn(
      `[adapters] ${missingTool} not found, skipping WASM build and using prebuilt artifacts`,
    );
    process.exit(0);
  }

  console.error(
    `[adapters] ${missingTool} is required because prebuilt browser WASM artifacts are missing:\n${missingArtifacts.join('\n')}`,
  );
  process.exit(1);
}
