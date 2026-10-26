import { readFileSync } from 'node:fs';

/** Only an explicit 404 means publishing this exact version is still necessary. */
export async function npmVersionExists(
  name: string,
  version: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const response = await request(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(`Cannot check ${name}@${version}: registry returned ${response.status}`);
  const published = await response.json();
  if (published.name !== name || published.version !== version)
    throw new Error(`Unexpected registry metadata for ${name}@${version}`);
  return true;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: node scripts/npm-version-exists.ts <package.json>');
  const { name, version } = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof name !== 'string' || !name || typeof version !== 'string' || !version)
    throw new Error(`Missing package name or version: ${path}`);
  console.log(await npmVersionExists(name, version));
}
