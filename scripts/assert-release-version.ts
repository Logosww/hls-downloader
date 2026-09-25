import { readFileSync } from 'node:fs';

const manifests = [
  'package.json',
  'packages/core/package.json',
  'packages/shared/package.json',
  'packages/adapters/package.json',
  'packages/adapters/src/node/package.json',
];

const versions = manifests.map((path) => ({
  path,
  version: JSON.parse(readFileSync(path, 'utf8')).version as string,
}));
const ref = process.env.GITHUB_REF ?? '';
const expected = ref.startsWith('refs/tags/v')
  ? ref.slice('refs/tags/v'.length)
  : versions[0].version;

for (const { path, version } of versions) {
  if (!version || version !== expected) {
    throw new Error(
      `Release version mismatch: ${path} is ${version}, expected ${expected}. Run pnpm run version:bump -- --version ${expected} before tagging.`,
    );
  }
}
console.log(`Release versions match: ${expected}`);
