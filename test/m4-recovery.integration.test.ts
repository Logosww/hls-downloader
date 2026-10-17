import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { HlsDownloader } from '../packages/core/src/index';
import { NodeAdapter } from '../packages/adapters/src/node/index';
import { key } from './fixtures/encrypted';
import { m4Profiles } from './fixtures/m4';
import { startFixtureServer } from './fixtures/http-server';
const files: string[] = [],
  directories: string[] = [];
const servers: Awaited<ReturnType<typeof startFixtureServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const path of files.splice(0)) {
    if (existsSync(path)) {
      const output = statSync(path);
      for (const name of readdirSync('.').filter((n) => n.startsWith('.hls-transmux-session-'))) {
        const candidate = statSync(name);
        // Only this test's retained publication hard link, never another job's.
        if (candidate.ino === output.ino && candidate.dev === output.dev) rmSync(name);
      }
    }
    rmSync(path, { force: true });
    rmSync(path + '.hls-partial', { force: true });
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function decoded(path: string) {
  return execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-xerror',
      '-i',
      path,
      '-map',
      '0',
      '-fps_mode',
      'passthrough',
      '-f',
      'framemd5',
      '-',
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => s.split(',').map((s) => s.trim()));
}
for (const profile of m4Profiles)
  it(`schema-2 interrupted/uninterrupted decoded parity: ${profile.name}`, async () => {
    const routes = profile.routes();
    const candidates = Object.keys(routes).filter((p) => /\.(ts|m4s|bin|cbc)$/.test(p));
    expect(candidates.length).toBeGreaterThan(1);
    const blocked = candidates.at(-1)!;
    const original = routes[blocked]!;
    let interrupted = true;
    routes[blocked] = (req, res) => {
      if (interrupted) {
        res.writeHead(503).end();
        return;
      }
      return original(req, res);
    };
    const server = await startFixtureServer(routes);
    servers.push(server);
    const directory = mkdtempSync(join(tmpdir(), 'm4-recovery-'));
    directories.push(directory);
    const filename = `m4-${randomUUID()}`,
      reference = `m4-${randomUUID()}`;
    files.push(resolve(filename + '.mp4'), resolve(reference + '.mp4'));
    const options = {
      url: server.origin + profile.url,
      filename,
      ...profile.options,
      maxRetry: 0,
      resume: { directory },
    };
    const dl = new HlsDownloader({ adapter: NodeAdapter });
    await expect(dl.download(options)).rejects.toMatchObject({ code: 'SEGMENT_FETCH_FAILED' });
    interrupted = false;
    const result = await new HlsDownloader({ adapter: NodeAdapter }).download(options);
    const clean = await dl.download({ ...options, filename: reference, resume: undefined });
    expect(decoded(result.filePath)).toEqual(decoded(clean.filePath));
    expect(result.report!.tracks.map((t) => [t.kind, t.codec, t.sampleCount])).toEqual(
      clean.report!.tracks.map((t) => [t.kind, t.codec, t.sampleCount]),
    );
    const requests = server.requests.length;
    await dl.download(options);
    expect(server.requests.length).toBe(requests);
    const state = JSON.parse(readFileSync(join(directory, 'engine-state.json'), 'utf8'));
    expect(state.schema).toBe(2);
    expect(state.journal).toEqual([]);
    expect(JSON.stringify(state)).not.toContain(key.toString('hex'));
  });
