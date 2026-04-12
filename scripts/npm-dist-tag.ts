/**
 * 根据 semver 版本决定 npm publish 的 dist-tag。
 * - 稳定版（无 `-`）：返回空字符串（使用默认 latest）。
 * - 预发布：取 `-` 后第一段标识符（如 beta.1 → beta，rc.0 → rc）；若该段为纯数字或非法则回退为 `next`。
 *
 * CLI：在仓库根执行 `node scripts/npm-dist-tag.ts`，从 packages/adapters/package.json 读 version，向 stdout 打印 tag（稳定版无输出）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 稳定版返回 ''；预发布返回 npm 可用的 dist-tag（小写，仅 a-z0-9-）。 */
export function distTagForVersion(version: string): string {
  const dash = version.indexOf('-');
  if (dash < 0) {
    return '';
  }
  const prerelease = version.slice(dash + 1);
  const first = prerelease.split('.')[0] ?? '';
  if (!first || /^\d+$/.test(first)) {
    return 'next';
  }
  const tag = first.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return tag || 'next';
}

function isPrimaryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const self = fileURLToPath(import.meta.url);
  const abs = resolve(entry);
  if (process.platform === 'win32') {
    return self.toLowerCase() === abs.toLowerCase();
  }
  return self === abs;
}

function main(): void {
  const root = process.cwd();
  const pkgPath = resolve(root, 'packages/adapters/package.json');
  const { version } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  process.stdout.write(distTagForVersion(version));
}

if (isPrimaryModule()) {
  main();
}
