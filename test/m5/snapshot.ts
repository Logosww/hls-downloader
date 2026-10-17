import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Copy current tracked + nonignored new source, including uncommitted M4 work.
// No git reset/stash and no pre-existing node_modules, dist, target or binaries.
const root = resolve(import.meta.dirname, '../..');
const destination = mkdtempSync(join(tmpdir(), 'hls-m5-source-'));
const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
].sort();
const sha256: Record<string, string> = {};
for (const file of files) {
  const from = join(root, file);
  if (!existsSync(from)) continue; // tracked deletions in the current candidate
  const to = join(destination, file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  sha256[file] = createHash('sha256').update(readFileSync(from)).digest('hex');
}
writeFileSync(
  join(destination, 'm5-source-manifest.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      kind: 'working-source snapshot, not a committed clean checkout',
      sha256,
    },
    null,
    2,
  ) + '\n',
);
console.log(destination);
