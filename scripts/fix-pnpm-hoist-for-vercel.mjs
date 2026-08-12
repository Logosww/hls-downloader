/**
 * Workaround for Next.js 16 + Turbopack nft trace + pnpm 11 incompatibility.
 *
 * Next.js Turbopack emits `.next/**/page.js.nft.json` files that reference
 * `node_modules/.pnpm/node_modules/<pkg>` paths (the pnpm "public hoist"
 * virtual-store root). pnpm 11 only populates that directory for transitive
 * deps of root packages — not for root deps themselves (next, react, ...),
 * so `vercel build` fails with ENOENT when tracing those entries.
 *
 * This script recreates the missing symlinks so the vercel trace step can
 * lstat them. Run it after `pnpm install` (via the root `postinstall` hook).
 */
import { symlink, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pnpmDir = join(root, 'node_modules', '.pnpm');
const virtualRoot = join(pnpmDir, 'node_modules');

// Packages that Next.js nft trace references via `.pnpm/node_modules/<pkg>`.
const PKGS = [
  '@swc/helpers',
  'client-only',
  'next',
  'react',
  'styled-jsx',
];

async function findPkgDir(name) {
  // Scoped packages are stored as `@swc+helpers@<ver>`; plain ones as `next@<ver>`.
  const encoded = name.replace('/', '+');
  const entries = await readdir(pnpmDir);
  // Prefer the entry whose `<pkg>/node_modules/<pkg>` actually exists.
  const candidates = entries.filter((e) => e.startsWith(`${encoded}@`));
  for (const candidate of candidates) {
    const dir = join(pnpmDir, candidate, 'node_modules', name);
    try {
      const st = await lstat(dir);
      if (st.isDirectory() || st.isSymbolicLink()) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

async function ensureSymlink(name) {
  const candidate = await findPkgDir(name);
  if (!candidate) {
    console.warn(`[fix-pnpm-hoist] skip ${name}: not found in .pnpm`);
    return;
  }
  const target = join('..', candidate, 'node_modules', name);
  const linkPath = join(virtualRoot, name);
  // Remove stale symlink/dir if present.
  try {
    await rm(linkPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(target, linkPath, 'dir');
  console.log(`[fix-pnpm-hoist] ${name} -> ${target}`);
}

async function main() {
  try {
    await lstat(pnpmDir);
