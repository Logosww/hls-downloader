#!/usr/bin/env bun

/**
 * Changelog helper script.
 *
 * Usage:
 *   bun scripts/changelog.ts                              # generate next version entry from git commits
 *   bun scripts/changelog.ts append <section> <message>   # append an entry to the latest Unreleased version
 *   bun scripts/changelog.ts sync                         # sync root CHANGELOG.md → docs/changelog.md
 *   bun scripts/changelog.ts sync --zh                    # also overwrite docs/zh/changelog.md (use with care)
 *
 * Sections: Added, Changed, Fixed, Removed, Documentation, Chore (case-insensitive)
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CHANGELOG_PATH = resolve(ROOT, 'CHANGELOG.md');
const DOCS_EN_PATH = resolve(ROOT, 'docs/changelog.md');
const DOCS_ZH_PATH = resolve(ROOT, 'docs/zh/changelog.md');

const TYPE_MAP: Record<string, string> = {
  feat: 'Added',
  fix: 'Fixed',
  perf: 'Changed',
  refactor: 'Changed',
  docs: 'Documentation',
  chore: 'Chore',
  ci: 'Chore',
  build: 'Chore',
  test: 'Chore',
  style: 'Chore',
  revert: 'Removed',
};

const SECTION_ORDER = ['Added', 'Changed', 'Fixed', 'Removed', 'Documentation', 'Chore'];

interface Commit {
  hash: string;
  type: string;
  message: string;
}

function git(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

function getLatestTag(): string | null {
  try {
    return git('git describe --tags --abbrev=0');
  } catch {
    return null;
  }
}

function getNextVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
  return pkg.version;
}

function parseCommits(raw: string): Commit[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line): Commit | null => {
      const match = line.match(/^([a-f0-9]+)\s+(.+)$/);
      if (!match) return null;
      const [, hash, message] = match;
      const typeMatch = message.match(/^(\w+)(?:\(.+?\))?:\s*(.+)$/);
      if (!typeMatch) return { hash, type: 'other', message };
      const [, type, description] = typeMatch;
      return { hash, type: type.toLowerCase(), message: description.trim() };
    })
    .filter((c): c is Commit => c !== null);
}

function categorize(commits: Commit[]): Record<string, Commit[]> {
  const sections: Record<string, Commit[]> = {};
  for (const commit of commits) {
    if (commit.type === 'release') continue;
    const section = TYPE_MAP[commit.type] || 'Other';
    (sections[section] ??= []).push(commit);
  }
  return sections;
}

function formatMarkdown(version: string, sections: Record<string, Commit[]>): string {
  const lines: string[] = [`## [${version}] - Unreleased`, ''];

  const orderedSections = SECTION_ORDER.filter((s) => sections[s]);
  if (sections['Other']) orderedSections.push('Other');

  for (const section of orderedSections) {
    const commits = sections[section];
    if (!commits?.length) continue;
    lines.push(`### ${section}`, '');
    for (const c of commits) {
      lines.push(`- ${c.message} (\`${c.hash.slice(0, 7)}\`)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generate(): void {
  const tag = getLatestTag();
  const version = getNextVersion();
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const rawLog = git(`git log ${range} --oneline --no-merges`);

  if (!rawLog) {
    console.log('No commits found since last tag.');
    return;
  }

  const commits = parseCommits(rawLog);
  const sections = categorize(commits);
  const md = formatMarkdown(version, sections);

  console.log('─'.repeat(60));
  console.log(`Generated changelog for v${version} (since ${tag || 'beginning'}):\n`);
  console.log(md);
  console.log('─'.repeat(60));
  console.log('\nPaste the above into CHANGELOG.md, then run:\n  bun scripts/changelog.ts sync\n');
}

function sync(flags: string[]): void {
  if (!existsSync(CHANGELOG_PATH)) {
    console.error('CHANGELOG.md not found at project root.');
    process.exit(1);
  }

  const content = readFileSync(CHANGELOG_PATH, 'utf-8');
  writeFileSync(DOCS_EN_PATH, content, 'utf-8');
  console.log(`✔ Synced → ${DOCS_EN_PATH}`);

  if (flags.includes('--zh')) {
    writeFileSync(DOCS_ZH_PATH, content, 'utf-8');
    console.log(`✔ Synced → ${DOCS_ZH_PATH} (remember to translate)`);
  } else {
    console.log(`ℹ Skipped docs/zh/changelog.md (pass --zh to overwrite; translate manually)`);
  }
}

const VALID_SECTIONS = [...SECTION_ORDER, 'Other'];

function resolveSection(input: string): string | null {
  const lower = input.toLowerCase();
  return VALID_SECTIONS.find((s) => s.toLowerCase() === lower) ?? null;
}

function append(args: string[]): void {
  if (args.length < 2) {
    console.error('Usage: bun scripts/changelog.ts append <section> <message>');
    console.error(`Sections: ${VALID_SECTIONS.join(', ')}`);
    process.exit(1);
  }

  const [rawSection, ...rest] = args;
  const section = resolveSection(rawSection);
  if (!section) {
    console.error(`Unknown section "${rawSection}". Valid: ${VALID_SECTIONS.join(', ')}`);
    process.exit(1);
  }

  const message = rest.join(' ').trim();
  if (!message) {
    console.error('Message cannot be empty.');
    process.exit(1);
  }

  if (!existsSync(CHANGELOG_PATH)) {
    console.error('CHANGELOG.md not found at project root.');
    process.exit(1);
  }

  const content = readFileSync(CHANGELOG_PATH, 'utf-8');
  const entry = `- ${message}`;

  const unreleasedMatch = content.match(/^(## \[.+?\] - Unreleased\n)/m);
  if (!unreleasedMatch) {
    console.error('No Unreleased version block found in CHANGELOG.md.');
    process.exit(1);
  }

  const unreleasedStart = content.indexOf(unreleasedMatch[0]);
  const nextVersionMatch = content.slice(unreleasedStart + unreleasedMatch[0].length).match(/^## \[/m);
  const unreleasedEnd = nextVersionMatch
    ? unreleasedStart + unreleasedMatch[0].length + nextVersionMatch.index!
    : content.length;

  const unreleasedBlock = content.slice(unreleasedStart, unreleasedEnd);
  const sectionHeader = `### ${section}`;
  const sectionIdx = unreleasedBlock.indexOf(sectionHeader);

  let updatedBlock: string;
  if (sectionIdx !== -1) {
    const afterHeader = sectionIdx + sectionHeader.length;
    const nextSectionMatch = unreleasedBlock.slice(afterHeader).match(/^### /m);

    let contentEnd: number;
    let tail: string;
    if (nextSectionMatch) {
      contentEnd = afterHeader + nextSectionMatch.index!;
      tail = unreleasedBlock.slice(contentEnd);
    } else {
      contentEnd = unreleasedBlock.length;
      tail = '';
    }

    let trimmed = contentEnd;
    while (trimmed > afterHeader && unreleasedBlock[trimmed - 1] === '\n') trimmed--;

    updatedBlock =
      unreleasedBlock.slice(0, trimmed) + '\n' + entry + '\n' + (tail ? '\n' + tail : '\n');
  } else {
    let trimmed = unreleasedBlock.length;
    while (trimmed > 0 && unreleasedBlock[trimmed - 1] === '\n') trimmed--;

    updatedBlock =
      unreleasedBlock.slice(0, trimmed) + '\n\n' + sectionHeader + '\n\n' + entry + '\n\n';
  }

  const updated = content.slice(0, unreleasedStart) + updatedBlock + content.slice(unreleasedEnd);
  writeFileSync(CHANGELOG_PATH, updated, 'utf-8');
  console.log(`✔ Appended to [${section}]: ${message}`);
}

const [subcommand, ...flags] = process.argv.slice(2);

switch (subcommand) {
  case 'sync':
    sync(flags);
    break;
  case 'append':
    append(flags);
    break;
  default:
    generate();
    break;
}
