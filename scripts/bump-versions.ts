/**
 * 一键同步提升根包与 workspace 核心包的版本号。
 *
 * Usage:
 *   pnpm run version:bump                              # 四个包均 patch +1
 *   pnpm run version:bump -- --minor                   # minor +1
 *   pnpm run version:bump -- --major                   # major +1
 *   pnpm run version:bump -- --version 2.0.0-beta.1    # 指定版本字符串（不做格式校验）
 *   pnpm run version:bump -- --changeset               # 通过 Changesets 执行 semver（patch/minor/major）
 *   pnpm run version:bump -- --dry-run                 # 仅打印，不写文件
 *
 * 说明：`--version` 与 `--changeset` 互斥；精确版本仅支持直接改写 package.json。
 * `--changeset`：根包不在 pnpm workspaces glob 内，仅对 core/shared/adapters 生成 changeset，再对齐根目录 version；
 * `updateInternalDependencies` 可能会一并抬高 app/docs 等依赖方版本，属预期行为。
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** 根包名不在 pnpm workspaces glob 内，Changesets 不会识别；--changeset 仅对下列三包写 changeset，再同步根版本。 */
const PACKAGES: { name: string; relPath: string }[] = [
  { name: '@logosw/hls-downloader', relPath: 'package.json' },
  { name: '@hls-downloader/core', relPath: 'packages/core/package.json' },
  { name: '@hls-downloader/shared', relPath: 'packages/shared/package.json' },
  { name: '@hls-downloader/adapters', relPath: 'packages/adapters/package.json' },
];

const CHANGESET_PACKAGES = PACKAGES.filter((p) => p.name !== '@logosw/hls-downloader');

type Release = 'patch' | 'minor' | 'major';

function parseArgs(argv: string[]) {
  let release: Release = 'patch';
  let explicitVersion: string | undefined;
  let useChangeset = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      console.log(`Usage: pnpm run version:bump [options]

Options:
  --patch            Patch 递增（默认）
  --minor            Minor 递增
  --major            Major 递增
  --version, -v <str>    将四个包设为同一 version 字段（不校验 semver 格式）
  --changeset        通过 @changesets/cli 执行 semver 递增（不支持与 --version 同用）
  --dry-run          只打印结果，不写文件、不执行 changeset version
`);
      process.exit(0);
    }
    if (a === '--patch') release = 'patch';
    else if (a === '--minor') release = 'minor';
    else if (a === '--major') release = 'major';
    else if (a === '--changeset') useChangeset = true;
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

  return { release, explicitVersion, useChangeset, dryRun };
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(v: string): [number, number, number] {
  const m = v.match(SEMVER_RE);
  if (!m) throw new Error(`Invalid semver (expect x.y.z): ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function bumpSemver(current: string, release: Release): string {
  const [major, minor, patch] = parseSemver(current);
  if (release === 'patch') return `${major}.${minor}.${patch + 1}`;
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

function injectAdaptersOptionalDeps(dryRun: boolean) {
  if (dryRun) {
    console.log('[dry-run] skip: adapters:inject-optional-deps');
    return;
  }
  execSync('node scripts/inject-adapters-optional-deps.ts', {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function runChangesetVersion(dryRun: boolean) {
  if (dryRun) {
    console.log('[dry-run] skip: pnpm exec changeset version');
    return;
  }
  execSync('pnpm exec changeset version', { cwd: ROOT, stdio: 'inherit' });
}

function writeChangesetFile(release: Release): string {
  const lines = [
    '---',
    ...CHANGESET_PACKAGES.map((p) => `"${p.name}": ${release}`),
    '---',
    '',
    'Bump package versions (automated by scripts/bump-versions.ts)',
    '',
  ];
  const name = `auto-bump-${Date.now()}.md`;
  const dir = resolve(ROOT, '.changeset');
  const path = resolve(dir, name);
  writeFileSync(path, lines.join('\n'), 'utf-8');
  return path;
}

const argv = process.argv.slice(2);
const { release, explicitVersion, useChangeset, dryRun } = parseArgs(argv);

if (explicitVersion && useChangeset) {
  console.error('Cannot use --version together with --changeset. Use direct bump for exact versions.');
  process.exit(1);
}

if (useChangeset) {
  if (dryRun) {
    console.log(
      `[dry-run] would add changeset (${release}) for: ${CHANGESET_PACKAGES.map((p) => p.name).join(', ')}`,
    );
    console.log('[dry-run] would run: pnpm exec changeset version');
    console.log('[dry-run] would sync root package.json version to match workspace packages');
    injectAdaptersOptionalDeps(true);
    process.exit(0);
  }
  const csPath = writeChangesetFile(release);
  console.log(`Created changeset: ${csPath}`);
  runChangesetVersion(false);
  const synced = readVersion('packages/core/package.json');
  writeVersion('package.json', synced, false);
  console.log(`Synced root @logosw/hls-downloader version to ${synced}`);
  injectAdaptersOptionalDeps(false);
  process.exit(0);
}

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

injectAdaptersOptionalDeps(dryRun);
