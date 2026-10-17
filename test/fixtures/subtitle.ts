import { createCipheriv } from 'node:crypto';
import { multiTrackRoutes } from './multitrack.ts';
import { sendText, sendBytes } from './http-server.ts';
export const key = Buffer.alloc(16, 7),
  rotated = Buffer.alloc(16, 9);
export function encrypted(mode = 'vod', map = true) {
  const routes = multiTrackRoutes('', { open: mode !== 'vod' });
  const encrypt = (text: string, k: Buffer, n: number) => {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(n, 12);
    const c = createCipheriv('aes-128-cbc', k, iv);
    return Buffer.concat([c.update(text), c.final()]);
  };
  routes['/key'] = (_, r) => sendBytes(r, key);
  routes['/rotated'] = (_, r) => sendBytes(r, rotated);
  routes['/cc-en/header'] = (_, r) =>
    sendBytes(r, encrypt('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0\n', key, 1));
  const header = map ? '' : 'WEBVTT\n\n';
  routes['/cc-en/one'] = (_, r) =>
    sendBytes(
      r,
      encrypt(
        header +
          'same\n00:00.100 --> 00:01.600 align:start\nHello\n\nsame\n00:00.100 --> 00:01.600 align:start\nHello\n',
        key,
        41,
      ),
    );
  routes['/cc-en/two'] = (_, r) =>
    sendBytes(r, encrypt(header + 'end\n00:01.600 --> 00:01.900\nEnd\n', rotated, 42));
  routes['/cc-en/media.m3u8'] = (_, r) =>
    sendText(
      r,
      '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:41\n' +
        (mode === 'event' ? '#EXT-X-PLAYLIST-TYPE:EVENT\n' : '') +
        (map
          ? '#EXT-X-KEY:METHOD=AES-128,URI="../key",IV=0x00000000000000000000000000000001\n#EXT-X-MAP:URI="header"\n'
          : '') +
        '#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXTINF:1,\none\n#EXT-X-KEY:METHOD=AES-128,URI="../rotated"\n#EXTINF:1,\ntwo\n' +
        (mode === 'vod' ? '#EXT-X-ENDLIST\n' : ''),
    );
  return routes;
}
