/**
 * napi 生成的平台子包 package.json 默认无 repository；带 --provenance 发布时 npm 会校验与 OIDC 登记仓库一致。
 * repository 字段与根 package.json 保持一致（仅子包固定 directory 指向 Rust 包根）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.cwd();
const npmDir = resolve(root, 'packages/adapters/src/node/npm');
const rootPkgPath = resolve(root, 'package.json');

type Repo = { type?: string; url?: string; directory?: string };
type PackageJson = {
  name?: string;
  repository?: string | Repo;
};

function readRootRepository(): { type: string; url: string } {
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as PackageJson;
  const r = rootPkg.repository;
  if (typeof r === 'string') {
    return { type: 'git', url: r };
  }
  if (r && typeof r === 'object' && r.url) {
    return { type: r.type ?? 'git', url: r.url };
  }
  throw new Error(`Could not read repository.url from ${rootPkgPath}`);
}

const baseRepo = readRootRepository();
if (!baseRepo.url) {
  throw new Error('Root package.json repository.url is missing');
}

let updated = 0;
for (const ent of readdirSync(npmDir, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  const pkgPath = join(npmDir, ent.name, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch {
    continue;
  }
  const pkg = JSON.parse(raw) as PackageJson;
  pkg.repository = {
    type: baseRepo.type,
    url: baseRepo.url,
    directory: 'packages/adapters/src/node',
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  updated += 1;
}

if (updated === 0) {
  console.warn(`No package.json found under ${npmDir} (run napi pre-publish first).`);
} else {
  console.log(`Injected repository into ${updated} native platform package(s).`);
}
