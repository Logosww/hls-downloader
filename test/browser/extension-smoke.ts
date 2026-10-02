import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { startFixtureServer, sendRange } from '../fixtures/http-server.ts';

const root = resolve(import.meta.dirname, '../..');
const project = resolve(root, 'test-results/extension');
mkdirSync(project, { recursive: true });
cpSync(resolve(root, 'test/fixtures/wxt'), project, { recursive: true });
// Install tools first, then unpack our actual tarballs without rewriting their contents.
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: project,
  stdio: 'inherit',
});
const tarballs = join(project, 'tarballs');
mkdirSync(tarballs, { recursive: true });
for (const [source, name] of [
  ['.', '@logosw/hls-downloader'],
  ['packages/shared', '@hls-downloader/shared'],
  ['packages/core', '@hls-downloader/core'],
  ['packages/adapters', '@hls-downloader/adapters'],
]) {
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tarballs], {
      cwd: resolve(root, source!),
      encoding: 'utf8',
    }),
  );
  const destination = join(project, 'node_modules', name!);
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    join(tarballs, packed.filename),
    '--strip-components=1',
    '-C',
    destination,
  ]);
}
for (const target of ['chrome', 'edge'])
  execFileSync(join(project, 'node_modules/.bin/wxt'), ['build', '-b', target], {
    cwd: project,
    stdio: 'inherit',
  });
const channel = process.env.HLS_EXTENSION_CHANNEL || 'chromium';
const output = join(project, channel === 'msedge' ? '.output/edge-mv3' : '.output/chrome-mv3');
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}
assert.ok(
  files(output).some((p) => p.endsWith('.wasm')),
  'Production output must contain local WASM',
);
for (const path of files(output).filter((p) => p.endsWith('.js'))) {
  assert.ok(
    !/from["']node:|require\(["']node:|native\.[\w-]+\.node/.test(readFileSync(path, 'utf8')),
    'Node native module in browser output',
  );
}
const routes: Parameters<typeof startFixtureServer>[0] = {
  '/login': (_request, response) => {
    response.writeHead(200, { 'Set-Cookie': 'fixture_session=ok; Path=/; HttpOnly; SameSite=Lax' });
    response.end('logged in');
  },
};
for (const kind of ['ts', 'fmp4', 'byterange'])
  for (const name of readdirSync(resolve(root, 'test/fixtures/media', kind))) {
    routes[`/${kind}/${name}`] = (request, response) => {
      if (!request.headers.cookie?.includes('fixture_session=ok')) {
        response.writeHead(401).end('session required');
        return;
      }
      if (
        request.headers.authorization !== 'Bearer fixture-only' ||
        !request.headers.referer?.endsWith('/watch')
      ) {
        response.writeHead(403).end('context required');
        return;
      }
      const bytes = readFileSync(resolve(root, 'test/fixtures/media', kind, name));
      if (name.endsWith('.m3u8')) {
        response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        response.end(bytes);
      } else sendRange(request, response, bytes);
    };
  }
const server = await startFixtureServer(routes);
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
try {
  context = await chromium.launchPersistentContext(join(project, 'profile'), {
    channel,
    executablePath: process.env.HLS_TEST_CHROMIUM_PATH,
    headless: process.env.HLS_EXTENSION_HEADED !== '1',
    args: ['--enable-unsafe-extension-debugging'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  const cdp = await context.browser()!.newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: output });
  const page = await context.newPage();
  await page.goto(server.origin + '/login');
  await page.goto(`chrome-extension://${id}/task.html`);
  await page.waitForFunction(() => typeof (window as any).runAcceptance === 'function');
  const result = await page.evaluate(
    (origin) => (window as any).runAcceptance(origin),
    server.origin,
  );
  assert.ok(
    server.requests.some((r) => r.headers.range),
    'Missing real Range requests',
  );
  const report = {
    browser: await context.browser()?.version(),
    ...result,
    chrome:
      process.env.HLS_EXTENSION_CHANNEL === 'chrome'
        ? 'passed'
        : 'pending actual Chrome acceptance',
    edge:
      process.env.HLS_EXTENSION_CHANNEL === 'msedge' ? 'passed' : 'pending actual Edge acceptance',
  };
  writeFileSync(join(project, `acceptance-${channel}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context?.close();
  await server.close();
}
