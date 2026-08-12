/**
 * 本地默认动态链接 FFmpeg（系统 pkg-config）；CI / 发布设 HLS_FFMPEG_STATIC=1 或传 --static 以启用 hls-napi 的 static-ffmpeg feature。
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const adaptersRoot = join(repoRoot, 'packages', 'adapters');
const nodeDir = join(adaptersRoot, 'src', 'node');

const useStatic =
  process.env.HLS_FFMPEG_STATIC === '1' || process.argv.includes('--static');

// 远程构建环境(如 Vercel)无 Rust 工具链时跳过 native 编译;
// app-web 只依赖 adapters/browser(wasm),不需要 native 产物。
const shell = process.platform === 'win32';
const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'pipe', shell });
if (cargoCheck.error || cargoCheck.status !== 0) {
  console.warn('[adapters] cargo not found, skipping native build');
  process.exit(0);
}

const args: string[] = [
  'exec',
  'napi',
  'build',
  '--manifest-path',
  'crates/napi/Cargo.toml',
  '--release',
  '--platform',
  '--js',
  'native.js',
  '--dts',
  'native.d.ts',
  '--output-dir',
  '.',
];
if (useStatic) {
  args.push('--', '-F', 'static-ffmpeg');
}

const r: SpawnSyncReturns<Buffer> = spawnSync('pnpm', args, {
  cwd: nodeDir,
  stdio: 'inherit',
  shell,
  env: process.env,
});
if (r.error) {
  console.error(r.error);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
