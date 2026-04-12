/**
 * 安装固定 vcpkg 基线（release tag 或 40 位 commit SHA），并以给定 triplet 安装 ffmpeg + pkgconf（供 ffmpeg-sys-next 静态链接）。
 * 在 GitHub Actions 下写入 GITHUB_ENV：VCPKG_ROOT、PKG_CONFIG、PKG_CONFIG_PATH、PKG_CONFIG_ALL_STATIC。
 *
 * Usage: node scripts/setup-vcpkg-ffmpeg.ts <triplet>
 * Env: VCPKG_ROOT（可选，默认 os.homedir()/vcpkg）、VCPKG_TAG（可选；默认同 workflow，为含 FFmpeg 8.1 的 vcpkg commit）
 *
 * GitHub Actions：缓存路径不要用 `~`，应与 Node 的 homedir 一致（Linux/macOS 用 $HOME/vcpkg，
 * Windows 用 Join-Path $env:USERPROFILE vcpkg）；workflow 里在 cache 前先解析并写入 VCPKG_ROOT。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const triplet = process.argv[2];
if (!triplet) {
  console.error('Usage: node scripts/setup-vcpkg-ffmpeg.ts <triplet>');
  process.exit(1);
}

/** 含 ports/ffmpeg 8.1 及后续修复；官方 tag 在 2026.03.18 仍为 8.0.1，故用 commit 固定。 */
const DEFAULT_VCPKG_REF = '03b9ab95fd5ea1425427ccde11d13e92aa91bf51';
const VCPKG_REMOTE = 'https://github.com/microsoft/vcpkg.git';
const VCPKG_TAG = process.env.VCPKG_TAG ?? DEFAULT_VCPKG_REF;
const root = process.env.VCPKG_ROOT ?? join(homedir(), 'vcpkg');
const isWin = process.platform === 'win32';
const isPinnedFullSha = /^[0-9a-f]{40}$/i.test(VCPKG_TAG);

function run(file: string, args: string[], cwd: string) {
  execFileSync(file, args, {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, VCPKG_ROOT: root },
  });
}

if (existsSync(root) && !existsSync(join(root, '.git'))) {
  const entries = readdirSync(root);
  if (entries.length > 0) {
    console.warn(`Removing incomplete VCPKG_ROOT (missing .git): ${root}`);
    rmSync(root, { recursive: true, force: true });
  }
}

if (!existsSync(join(root, '.git'))) {
  if (isPinnedFullSha) {
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init'], { stdio: 'inherit', cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', VCPKG_REMOTE], { stdio: 'inherit', cwd: root });
    execFileSync('git', ['fetch', '--depth', '1', 'origin', VCPKG_TAG], { stdio: 'inherit', cwd: root });
    execFileSync('git', ['checkout', 'FETCH_HEAD'], { stdio: 'inherit', cwd: root });
  } else {
    execFileSync('git', ['clone', '--depth', '1', '--branch', VCPKG_TAG, VCPKG_REMOTE, root], {
      stdio: 'inherit',
    });
  }
}

const vcpkgExe = isWin ? join(root, 'vcpkg.exe') : join(root, 'vcpkg');
if (!existsSync(vcpkgExe)) {
  if (isWin) {
    execFileSync('cmd.exe', ['/c', join(root, 'bootstrap-vcpkg.bat'), '-disableMetrics'], {
      stdio: 'inherit',
      cwd: root,
      env: { ...process.env, VCPKG_ROOT: root },
    });
  } else {
    run(join(root, 'bootstrap-vcpkg.sh'), ['-disableMetrics'], root);
  }
}

if (!existsSync(vcpkgExe)) {
  throw new Error(`vcpkg binary missing after bootstrap: ${vcpkgExe}`);
}

execFileSync(vcpkgExe, ['install', `ffmpeg:${triplet}`, `pkgconf:${triplet}`], {
  stdio: 'inherit',
  env: { ...process.env, VCPKG_ROOT: root },
});

const installed = join(root, 'installed', triplet);
const pcDir = join(installed, 'lib', 'pkgconfig');
const pkgConf = join(installed, 'tools', 'pkgconf', isWin ? 'pkgconf.exe' : 'pkgconf');

if (!existsSync(pkgConf)) {
  throw new Error(`pkgconf not found: ${pkgConf}`);
}

/** vcpkg 自带的 pkgconf 默认不扫系统目录；Cargo/openssl-sys 仍需系统里的 openssl.pc 等。 */
function extraSystemPkgConfigPath(): string {
  if (isWin) {
    return '';
  }
  if (process.platform === 'darwin') {
    const paths: string[] = [];
    for (const formula of ['openssl@3', 'openssl']) {
      try {
        const prefix = execFileSync('brew', ['--prefix', formula], { encoding: 'utf8' }).trim();
        const pc = join(prefix, 'lib', 'pkgconfig');
        if (existsSync(pc)) {
          paths.push(pc);
        }
      } catch {
        /* brew 或 formula 不存在 */
      }
    }
    return paths.join(':');
  }
  const candidates = [
    '/usr/lib/pkgconfig',
    '/usr/share/pkgconfig',
    '/usr/lib/x86_64-linux-gnu/pkgconfig',
    '/usr/lib/aarch64-linux-gnu/pkgconfig',
    '/usr/lib/arm-linux-gnueabihf/pkgconfig',
  ];
  return candidates.filter((p) => existsSync(p)).join(':');
}

const extraPc = extraSystemPkgConfigPath();
const pkgConfigPath = extraPc ? `${pcDir}:${extraPc}` : pcDir;

const lines = [
  `VCPKG_ROOT=${root}`,
  `PKG_CONFIG=${pkgConf}`,
  `PKG_CONFIG_PATH=${pkgConfigPath}`,
  'PKG_CONFIG_ALL_STATIC=1',
];

const gh = process.env.GITHUB_ENV;
if (gh) {
  for (const line of lines) {
    appendFileSync(gh, `${line}\n`);
  }
} else {
  console.log('Export for local shell:');
  for (const line of lines) {
    const [k, ...rest] = line.split('=');
    console.log(`export ${k}="${rest.join('=')}"`);
  }
}

console.log(`vcpkg FFmpeg OK: triplet=${triplet} tag=${VCPKG_TAG}`);
