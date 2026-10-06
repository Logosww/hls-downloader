import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sendBytes, sendText, type FixtureHandler } from './http-server.ts';
export const timelineCases = ['cases.json', 'supplemental.json'].flatMap((file) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'timeline', file), 'utf8')),
) as any[];
export const sampleKey = Uint8Array.from(Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex'));
export function timelineRoutes(c: any, prefix = ''): Record<string, FixtureHandler> {
  const routes: Record<string, FixtureHandler> = {};
  for (const [url, file] of Object.entries(c.files))
    routes[prefix + new URL(url).pathname] = (_, res) =>
      sendBytes(res, readFileSync(resolve(import.meta.dirname, 'timeline', file as string)));
  for (const snapshot of [c.request.primary, c.request.audio].filter(Boolean))
    routes[prefix + new URL(snapshot.url).pathname] = (_, res) =>
      sendText(
        res,
        snapshot.text
          .replace(
            /URI="([^"]+)"/g,
            (_: string, uri: string) =>
              'URI="' + prefix + new URL(uri, snapshot.url).pathname + '"',
          )
          .split('\n')
          .map((line: string) =>
            !line || line.startsWith('#') ? line : prefix + new URL(line, snapshot.url).pathname,
          )
          .join('\n'),
      );
  routes[prefix + '/master.m3u8'] = (_, res) =>
    sendText(
      res,
      '#EXTM3U\n' +
        (c.request.audio
          ? '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="' +
            prefix +
            new URL(c.request.audio.url).pathname +
            '"\n'
          : '') +
        '#EXT-X-STREAM-INF:BANDWIDTH=100000' +
        (c.request.audio ? ',AUDIO="a"' : '') +
        '\n' +
        prefix +
        new URL(c.request.primary.url).pathname +
        '\n',
    );
  return routes;
}
export function timelineOptions(c: any) {
  return {
    timeline: {
      ...(c.selection.range ? { range: c.selection.range } : {}),
      gapPolicy: c.selection.collapse ? ('collapse' as const) : ('preserve' as const),
      ...(c.selection.split ? { changePolicy: 'split' as const } : {}),
    },
    decryption: {
      encryptedRanges: 'complete-resources' as const,
      keyResolver: async (r: { originalSequence: string; resourceKind: string }) => ({
        key:
          r.resourceKind === 'media' && r.originalSequence === '9007199254740994'
            ? Uint8Array.from(Buffer.from('603deb1015ca71be2b73aef0857d7781', 'hex'))
            : sampleKey,
      }),
    },
  };
}
