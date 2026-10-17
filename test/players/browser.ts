import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../../test-results/players');
const shaka =
  process.env.HLS_SHAKA_PATH ?? '/tmp/hls-player-tools/shaka/dist/shaka-player.compiled.debug.js';
const results = new Map<string, unknown>();
const server = createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://local');
  if (req.method === 'POST' && u.pathname === '/results') {
    const chunks = [];
    for await (const b of req) chunks.push(b);
    const r = JSON.parse(Buffer.concat(chunks).toString());
    const runtime = u.searchParams.get('runtime')!;
    results.set(runtime, r);
    writeFileSync(resolve(root, 'browser-' + runtime + '.json'), JSON.stringify(r, null, 2));
    res.end('ok');
    return;
  }
  const p =
    u.pathname === '/shaka.js'
      ? shaka
      : u.pathname === '/browser.html'
        ? resolve(import.meta.dirname, 'browser.html')
        : resolve(root, u.pathname.replace(/^\/media\//, '').replace(/^\//, ''));
  if (!p.startsWith(root) && p !== shaka && p !== resolve(import.meta.dirname, 'browser.html')) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(p)) {
    res.writeHead(404).end();
    return;
  }
  const b = readFileSync(p);
  const type = p.endsWith('.html')
    ? 'text/html'
    : p.endsWith('.js')
      ? 'text/javascript'
      : p.endsWith('.vtt')
        ? 'text/vtt'
        : p.endsWith('.json')
          ? 'application/json'
          : 'video/mp4';
  res.setHeader('Content-Type', type);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]),
      end = range[2] ? Math.min(Number(range[2]), b.length - 1) : b.length - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${b.length}`,
      'Content-Length': end - start + 1,
    });
    res.end(b.subarray(start, end + 1));
  } else {
    res.setHeader('Content-Length', b.length);
    res.end(b);
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port,
  url = `http://127.0.0.1:${port}/browser.html`;
console.log(url);
mkdirSync(resolve(root, 'screenshots'), { recursive: true });
try {
  if (process.env.HLS_PLAYER_SAFARI === '1')
    execFileSync('open', ['-a', 'Safari', url + '?runtime=safari&auto=1']);
  if (process.env.HLS_PLAYER_CHROME !== '0') {
    const browser = await chromium.launch({
      executablePath:
        process.env.HLS_TEST_CHROMIUM_PATH ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    try {
      const page = await browser.newPage();
      await page.exposeFunction('capture', async (name: string) => {
        await page.screenshot({ path: resolve(root, 'screenshots', name + '-chrome.png') });
      });
      await page.goto(url + '?runtime=chrome');
      await page.evaluate(() => (window as any).runPlayers());
    } finally {
      await browser.close();
    }
  }
  if (process.env.HLS_PLAYER_SAFARI === '1') {
    const deadline = Date.now() + 120000;
    while (!results.has('safari') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 500));
    if (!results.has('safari')) throw Error('Safari did not return results within deadline');
  }
  console.log(JSON.stringify([...results]));
} finally {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
