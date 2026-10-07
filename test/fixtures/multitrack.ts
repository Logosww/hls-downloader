import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sendBytes, sendText, type FixtureHandler } from './http-server.ts';
export const multiTrackSelection = {
  embeddedAudio: 'exclude' as const,
  audioTracks: [
    { id: 'english', selector: { groupId: 'a', name: 'English' } },
    { id: 'japanese', selector: { language: 'ja' } },
  ],
  subtitleTracks: [
    { id: 'captions-en', selector: { groupId: 's', name: 'English' } },
    { id: 'captions-ja', selector: { groupId: 's', name: 'Japanese' } },
  ],
};
export function multiTrackRoutes(
  prefix = '',
  options: { primary?: string; audio?: string; open?: boolean; subtitle?: string } = {},
) {
  const routes: Record<string, FixtureHandler> = {};
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en/media.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",LANGUAGE="ja",DEFAULT=NO,URI="ja/media.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="cc-en/media.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Japanese",LANGUAGE="ja",DEFAULT=NO,URI="cc-ja/media.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=128x72,AUDIO="a",SUBTITLES="s"
video/media.m3u8
`;
  routes[prefix + '/master.m3u8'] = (_, res) => sendText(res, master);
  for (const [url, dir] of [
    ['video', options.primary ?? 'fmp4'],
    ['en', options.audio ?? 'audio-fmp4'],
    ['ja', options.audio ?? 'audio-fmp4'],
  ]) {
    const root = resolve(import.meta.dirname, 'media', dir!);
    for (const file of readdirSync(root)) {
      const data = readFileSync(resolve(root, file));
      routes[`${prefix}/${url}/${file}`] = (_, res) =>
        file.endsWith('m3u8')
          ? sendText(
              res,
              options.open ? data.toString().replace('#EXT-X-ENDLIST', '') : data.toString(),
            )
          : sendBytes(res, data);
    }
  }
  for (const language of ['en', 'ja']) {
    routes[`${prefix}/cc-${language}/media.m3u8`] = (_, res) =>
      sendText(
        res,
        '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ntext.vtt\n' +
          (options.open ? '' : '#EXT-X-ENDLIST\n'),
      );
    routes[`${prefix}/cc-${language}/text.vtt`] = (_, res) =>
      sendText(
        res,
        options.subtitle ??
          `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:${(options.primary ?? '').endsWith('ts') ? 126000 : 0}\n\nfirst-${language}\n00:00.100 --> 00:01.600 align:start position:20%,line-left line:10% size:70%\n${language === 'en' ? 'Hello' : 'こんにちは'}\n\noverlap-${language}\n00:00.500 --> 00:01.000 vertical:rl\nSecond\n`,
      );
  }
  return routes;
}
export function packedRoutes(kind: string, prefix = '') {
  const routes: Record<string, FixtureHandler> = {};
  const root = resolve(import.meta.dirname, 'packed-aac', kind);
  for (const file of readdirSync(root)) {
    const data = readFileSync(resolve(root, file));
    routes[prefix + '/' + file] = (_, res) =>
      file.endsWith('.m3u8') ? sendText(res, data.toString()) : sendBytes(res, data);
  }
  return routes;
}
export function packedKey(uri: string) {
  return new Uint8Array(
    Buffer.from(
      uri.includes('rotated')
        ? '603deb1015ca71be2b73aef0857d7781'
        : '2b7e151628aed2a6abf7158809cf4f3c',
      'hex',
    ),
  );
}
