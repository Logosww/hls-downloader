import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HlsDownloader } from '../packages/core/src';
import { NodeAdapter } from '../packages/adapters/src/node';
import { BrowserAdapter } from '../packages/adapters/src/browser';
import { isPublicAddress, lookupPublicAddress } from '../packages/adapters/src/node/request';
import { encryptedRoutes } from './fixtures/encrypted';
import { startFixtureServer, sendText, type FixtureHandler } from './fixtures/http-server';

const controlledDns = vi.hoisted(() => vi.fn());
vi.mock('node:dns', async (load) => {
  const dns = await load<typeof import('node:dns')>();
  return {
    ...dns,
    lookup(...args: Parameters<typeof dns.lookup>) {
      if (args[0] === 'media.test') return controlledDns(...args);
      return dns.lookup(...args);
    },
  };
});

it('returns only the verified DNS answers to the connector', async () => {
  const answer = [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ];
  controlledDns.mockImplementation((_host, _options, done) => done(null, answer));
  const resolve = () =>
    new Promise((ok, fail) => {
      lookupPublicAddress('media.test', { all: true }, (err, addresses) =>
        err ? fail(err) : ok(addresses),
      );
    });
  expect(await resolve()).toEqual(answer);
  expect(controlledDns).toHaveBeenCalledTimes(1);
  answer.push({ address: '127.0.0.1', family: 4 });
  await expect(resolve()).rejects.toMatchObject({ code: 'REQUEST_POLICY_DENIED' });
});

const servers: Awaited<ReturnType<typeof startFixtureServer>>[] = [];
async function serve(routes: Record<string, FixtureHandler>) {
  const server = await startFixtureServer(routes);
  servers.push(server);
  return server;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const media = (uri: string) =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${uri}\n#EXT-X-ENDLIST\n`;
const headers = { Authorization: 'Bearer fixture', Cookie: 'session=fixture' };
const node = () => new HlsDownloader({ adapter: NodeAdapter });

it('isolates both caches by owner and headers, and invalidates only the current owner', async () => {
  const segment = readFileSync(join(import.meta.dirname, 'fixtures/media/ts/segment-00.ts'));
  const server = await serve({
    '/list': (r, res) => sendText(res, media('/segment?user=' + r.headers.authorization)),
    '/segment': (_, res) => {
      res.end(segment);
    },
  });
  const url = server.origin + '/list';
  const a = node(),
    b = node();
  for (const [client, auth] of [
    [a, 'A'],
    [b, 'A'],
    [a, 'B'],
  ] as const) {
    const options = { url, headers: { Authorization: auth } };
    expect(await client.parseHls(options)).toMatchObject({
      data: [{ uri: server.origin + '/segment?user=' + auth }],
    });
    expect(await client.getPosterUrl(options)).toMatch(/^data:image\/jpeg;base64,.+/);
    await client.getPosterUrl({ url, headers: { authorization: auth } });
  }
  expect(server.requests.map((r) => r.path)).toEqual([
    '/list',
    '/segment',
    '/list',
    '/segment',
    '/list',
    '/segment',
  ]);
  a.clearCache();
  await b.getPosterUrl({ url, headers: { authorization: 'A' } });
  await a.getPosterUrl({ url, headers: { authorization: 'A' } });
  expect(server.attempts.get('/list')).toBe(4);
  expect(server.attempts.get('/segment')).toBe(4);
  const cancelled = { url, headers: { authorization: 'A' }, signal: AbortSignal.abort() };
  expect(await a.parseHls(cancelled)).toMatchObject({
    error: { code: 'ABORTED', adapter: 'NodeAdapter' },
  });
  await expect(a.getPosterUrl(cancelled)).rejects.toMatchObject({ code: 'ABORTED' });
});

it('does not repopulate a cleared cache after an in-flight request', async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const server = await serve({
    '/list': async (r, res) => {
      started.resolve();
      await finish.promise;
      sendText(res, media(r.attempt + '.ts'));
    },
  });
  const d = node(),
    options = { url: server.origin + '/list' };
  const first = d.parseHls(options);
  await started.promise;
  d.clearCache();
  finish.resolve();
  expect(await first).toMatchObject({ data: [{ uri: server.origin + '/1.ts' }] });
  expect(await d.parseHls(options)).toMatchObject({ data: [{ uri: server.origin + '/2.ts' }] });
});

for (const [runtime, adapter] of [
  ['Node', NodeAdapter],
  ['Browser', BrowserAdapter],
] as const) {
  it.each([false, true])(
    `${runtime} scopes credentials for variants, keys, maps, segments and subtitles (trusted=%s)`,
    async (trusted) => {
      const fetch = globalThis.fetch;
      vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) =>
        String(input).startsWith('file:')
          ? new Response(
              readFileSync(
                join(
                  import.meta.dirname,
                  '../packages/adapters/src/browser/generated/hls_transmux_browser_wasm_bg.wasm',
                ),
              ),
              { headers: { 'content-type': 'application/wasm' } },
            )
          : fetch(input, init),
      );
      const cdn = await serve({
        ...encryptedRoutes('fmp4'),
        '/clear': (_, res) => sendText(res, media('clear.ts')),
        '/clear.ts': (_, res) => {
          res.end(readFileSync(join(import.meta.dirname, 'fixtures/media/ts/segment-00.ts')));
        },
        '/subs': (_, res) => sendText(res, media('captions.vtt')),
        '/captions.vtt': (_, res) =>
          sendText(
            res,
            'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:126000\n\n00:00:00.100 --> 00:00:00.200\nHello\n',
          ),
      });
      const entry = await serve({
        '/master': (r, res) =>
          sendText(
            res,
            `#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="${cdn.origin}/subs"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="s"\n${cdn.origin}/${r.query.has('clear') ? 'clear' : 'video/media.m3u8'}\n`,
          ),
      });
      const d = new HlsDownloader({
        adapter,
        options: { trustedCredentialOrigins: trusted ? [cdn.origin] : [] },
      });
      await d.downloadToStream({ url: entry.origin + '/master', headers }, () => {});
      const result = await d.downloadSubtitles({
        url: entry.origin + '/master?clear',
        headers,
        subtitle: { groupId: 's', name: 'English' },
      });
      expect(result.text).toContain('Hello');
      expect(entry.requests[0]!.headers).toMatchObject({
        authorization: headers.Authorization,
        cookie: headers.Cookie,
      });
      expect(cdn.requests.map((r) => r.path)).toEqual(
        expect.arrayContaining([
          '/key',
          '/subs',
          '/captions.vtt',
          '/video/media.m3u8',
          '/video/init.mp4',
        ]),
      );
      for (const r of cdn.requests) {
        expect(r.headers.authorization).toBe(trusted ? headers.Authorization : undefined);
        expect(r.headers.cookie).toBe(trusted ? headers.Cookie : undefined);
      }
    },
  );
}

it.each([false, true])(
  'uses the initial origin through nested poster selection (trusted=%s)',
  async (trusted) => {
    const segment = readFileSync(join(import.meta.dirname, 'fixtures/media/ts/segment-00.ts'));
    const cdn = await serve({
      '/media': (_, res) => sendText(res, media('poster.ts')),
      '/poster.ts': (_, res) => {
        res.end(segment);
      },
    });
    const entry = await serve({
      '/master': (_, res) =>
        sendText(res, `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n${cdn.origin}/media\n`),
    });
    const d = new HlsDownloader({
      adapter: NodeAdapter,
      options: { trustedCredentialOrigins: trusted ? [cdn.origin] : [] },
    });
    expect(await d.getPosterUrl({ url: entry.origin + '/master', headers })).toMatch(/^data:image/);
    expect(cdn.requests.map((r) => r.path)).toEqual(['/media', '/poster.ts']);
    for (const r of cdn.requests) {
      expect(r.headers.authorization).toBe(trusted ? headers.Authorization : undefined);
      expect(r.headers.cookie).toBe(trusted ? headers.Cookie : undefined);
    }
  },
);

it('checks redirect origins and resolves relative resources against the final URL', async () => {
  const cdn = await serve({ '/video/list': (_, res) => sendText(res, media('../sample.ts')) });
  const entry = await serve({
    '/redirect': (_, res) => {
      res.writeHead(302, { location: cdn.origin + '/video/list' }).end();
    },
  });
  const d = node(),
    options = { url: entry.origin + '/redirect', headers };
  expect(await d.parseHls(options)).toMatchObject({ data: [{ uri: cdn.origin + '/sample.ts' }] });
  expect(cdn.requests[0]!.headers.authorization).toBeUndefined();
  d.setOptions({ trustedCredentialOrigins: [cdn.origin] });
  await d.parseHls(options);
  expect(cdn.requests[1]!.headers.authorization).toBe(headers.Authorization);
  d.setOptions({ nodeRequestPolicy: { allowedOrigins: [entry.origin] } });
  expect(await d.parseHls(options)).toMatchObject({ error: { code: 'REQUEST_POLICY_DENIED' } });
  expect(cdn.requests).toHaveLength(2);
});

it('rejects non-public IP literals and DNS results before the HTTP request', async () => {
  const server = await serve({});
  const d = new HlsDownloader({
    adapter: NodeAdapter,
    options: { nodeRequestPolicy: { publicOnly: true } },
  });
  const port = new URL(server.origin).port;
  for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', 'localhost']) {
    expect(await d.parseHls({ url: `http://${host}:${port}/list` })).toMatchObject({
      error: { code: 'REQUEST_POLICY_DENIED' },
    });
  }
  expect(isPublicAddress('8.8.8.8')).toBe(true);
  expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  expect(server.requests).toHaveLength(0);
});

it('applies allowedOrigins to derived keys and rejects aria2 before fetching', async () => {
  const cdn = await serve({});
  const entry = await serve({
    '/list': (_, res) =>
      sendText(
        res,
        media('a.ts').replace(
          '#EXTINF:',
          `#EXT-X-KEY:METHOD=AES-128,URI="${cdn.origin}/key"\n#EXTINF:`,
        ),
      ),
    '/a.ts': (_, res) => {
      res.end(Buffer.alloc(16));
    },
  });
  const d = new HlsDownloader({
    adapter: NodeAdapter,
    options: { nodeRequestPolicy: { allowedOrigins: [entry.origin] } },
  });
  const url = entry.origin + '/list';
  await expect(d.download({ url, aria2: { enabled: true } })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OUTPUT',
  });
  await expect(node().download({ url, headers, aria2: { enabled: true } })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OUTPUT',
  });
  await expect(
    node().download({
      url,
      aria2: { enabled: true, extraArgs: ['--header', 'Authorization: fixture'] },
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OUTPUT' });
  expect(entry.requests).toHaveLength(0);
  await expect(d.downloadToStream({ url }, () => {})).rejects.toMatchObject({
    code: 'REQUEST_POLICY_DENIED',
  });
  expect(cdn.requests).toHaveLength(0);
});

it.each([false, true])(
  'cancels a live response at the server (body started=%s)',
  async (bodyStarted) => {
    const started = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const entry = await serve({
      '/list': (_, res) => {
        res.on('close', closed.resolve);
        if (bodyStarted) res.write('#EXTM3U\n');
        started.resolve();
      },
    });
    const controller = new AbortController();
    const result = node().parseHls({ url: entry.origin + '/list', signal: controller.signal });
    await started.promise;
    controller.abort();
    expect(await result).toMatchObject({ error: { code: 'ABORTED' } });
    await closed.promise;
  },
);

it('bounds streamed manifests and poster bytes and accepts the exact manifest limit', async () => {
  const cap = 4 * 1024 * 1024;
  const base = media('segment');
  const entry = await serve({
    '/exact': (_, res) => sendText(res, base.padEnd(cap, ' ')),
    '/chunked': (_, res) => {
      res.write(base);
      res.end(Buffer.alloc(cap));
    },
    '/declared': (_, res) => {
      res.writeHead(200, { 'content-length': cap + 1 });
      res.flushHeaders();
    },
    '/list': (_, res) => sendText(res, base),
    '/segment': (_, res) => {
      res.write(Buffer.alloc(16 * 1024 * 1024));
      res.end('x');
    },
  });
  const d = node();
  for (const path of ['/chunked', '/declared'])
    expect(await d.parseHls({ url: entry.origin + path })).toMatchObject({
      error: { code: 'RESOURCE_LIMIT_EXCEEDED' },
    });
  expect(await d.parseHls({ url: entry.origin + '/exact' })).toMatchObject({ type: 'segment' });
  await expect(d.getPosterUrl({ url: entry.origin + '/list' })).rejects.toMatchObject({
    code: 'RESOURCE_LIMIT_EXCEEDED',
  });
  expect(entry.attempts.get('/segment')).toBe(1);
});
