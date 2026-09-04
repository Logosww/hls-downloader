/**
 * 一键同步提升根包与 workspace 核心包的版本号。
 *
 * Usage:
 *   pnpm run version:bump                              # 默认 patch：稳定版 +0.0.1；预发布 (beta/rc/alpha 等) → 同号正式版
 *   pnpm run version:bump -- --minor                   # minor +1
 *   pnpm run version:bump -- --major                   # major +1
 *   pnpm run version:bump -- --version 2.0.0-beta.1    # 指定版本字符串（不做格式校验）
 *   pnpm run version:bump -- --dry-run                 # 仅打印，不写文件
 *
 * adapters 与 rust-native 的 optionalDependencies（各平台 native 包）仅在发布流水线里注入，本脚本只改 `version`，避免 CI 在包未发布时 `pnpm i` 与 lockfile 不一致。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** 参与统一升版的包。 */
const PACKAGES: { name: string; relPath: string }[] = [
  { name: '@logosw/hls-downloader', relPath: 'package.json' },
  { name: '@hls-downloader/core', relPath: 'packages/core/package.json' },
  { name: '@hls-downloader/shared', relPath: 'packages/shared/package.json' },
  { name: '@hls-downloader/adapters', relPath: 'packages/adapters/package.json' },
  { name: '@hls-downloader/rust-native', relPath: 'packages/adapters/src/node/package.json' },
];

type Release = 'patch' | 'minor' | 'major';

function parseArgs(argv: string[]) {
  let release: Release = 'patch';
  let explicitVersion: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(`Usage: pnpm run version:bump [options]

Options:
  --patch            Patch（默认）：稳定版 x.y.(z+1)；预发布 x.y.z-tag → x.y.z
  --minor            Minor 递增
  --major            Major 递增
  --version, -v <str>    将上述包设为同一 version 字段（不校验 semver 格式）
  --dry-run          只打印结果，不写文件
`);
      process.exit(0);
    }
    if (a === '--patch') release = 'patch';
    else if (a === '--minor') release = 'minor';
    else if (a === '--major') release = 'major';
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--version' || a === '-v') {
      const raw = argv[++i];
      if (!raw) {
        console.error('Missing value for --version');
        process.exit(1);
      }
      explicitVersion = raw.trim();
      if (!explicitVersion) {
        console.error('Empty value for --version');
        process.exit(1);
      }
    }
  }

  return { release, explicitVersion, dryRun };
}

/** x.y.z，可选 -prerelease、+build（与 node-semver 常见写法一致） */
const VERSION_HEAD = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+([^\s]*))?$/;

function parseVersionParts(v: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
} {
  const m = v.trim().match(VERSION_HEAD);
  if (!m) {
    throw new Error(`Invalid version (expect x.y.z with optional -prerelease +build): ${v}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: Boolean(m[4]),
  };
}

function bumpSemver(current: string, release: Release): string {
  const { major, minor, patch, prerelease } = parseVersionParts(current);
  if (release === 'patch') {
    if (prerelease) return `${major}.${minor}.${patch}`;
    return `${major}.${minor}.${patch + 1}`;
  }
  if (release === 'minor') return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

function readVersion(relPath: string): string {
  const full = resolve(ROOT, relPath);
  const pkg = JSON.parse(readFileSync(full, 'utf-8')) as { version: string };
  return pkg.version;
}

function writeVersion(relPath: string, version: string, dryRun: boolean) {
  const full = resolve(ROOT, relPath);
  const raw = readFileSync(full, 'utf-8');
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const prev = pkg.version;
  pkg.version = version;
  const next = `${JSON.stringify(pkg, null, 2)}\n`;
  if (dryRun) {
    console.log(`[dry-run] ${relPath}: ${prev} → ${version}`);
    return;
  }
  writeFileSync(full, next, 'utf-8');
  console.log(`Updated ${relPath}: ${prev} → ${version}`);
}

const argv = process.argv.slice(2);
const { release, explicitVersion, dryRun } = parseArgs(argv);

// 直接改写各 package.json
if (explicitVersion) {
  for (const p of PACKAGES) {
    writeVersion(p.relPath, explicitVersion, dryRun);
  }
} else {
  const bases = PACKAGES.map((p) => readVersion(p.relPath));
  if (bases.some((v) => v !== bases[0])) {
    console.warn(
      'Warning: packages currently have different versions; each will be bumped independently from its own base.',
    );
  }
  for (const p of PACKAGES) {
    const cur = readVersion(p.relPath);
    const next = bumpSemver(cur, release);
    writeVersion(p.relPath, next, dryRun);
  }
}
