import { shiftTsTimestamps } from './continuous-ts.ts';
import { createCipheriv } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sendBytes, sendText, type FixtureHandler } from './http-server.ts';

export const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
export const sequence = 9007199254740993n;
export function encrypt(bytes: Uint8Array, seq: bigint, secret = key): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(seq, 8);
  const cipher = createCipheriv('aes-128-cbc', secret, iv);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
/** Independent Node/OpenSSL encryption over the SDK's reproducible clear fixtures. */
export function encryptedRoutes(
  format = 'ts',
  audio = false,
  mixed = false,
  alignClocks = true,
): Record<string, FixtureHandler> {
  const routes: Record<string, FixtureHandler> = {
    '/key': (_, res) => sendBytes(res, key),
    '/master.m3u8': (_, res) =>
      sendText(
        res,
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio/media.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a"\nvideo/media.m3u8\n',
      ),
  };
  for (const [prefix, folder, seq] of [
    ['video', format, sequence],
    ...(audio ? [['audio', 'audio-' + (format === 'ts' ? 'fmp4' : 'ts'), 41n]] : []),
  ] as [string, string, bigint][]) {
    const base = resolve(import.meta.dirname, 'media', folder);
    const names = readdirSync(base).filter((n) => !n.endsWith('.m3u8'));
    let playlist = readFileSync(resolve(base, 'media.m3u8'), 'utf8').replace(
      '#EXT-X-MEDIA-SEQUENCE:0',
      `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    );
    let index = 0;
    playlist = playlist
      .split('\n')
      .flatMap((line) => {
        if (line.startsWith('#EXT-X-MAP:'))
          return [`#EXT-X-KEY:METHOD=AES-128,URI="/key",IV=0x${'0'.repeat(31)}1`, line];
        if (!line || line.startsWith('#')) return [line];
        const clear = mixed && index === 1;
        const original = readFileSync(resolve(base, line));
        // Mixed containers share a clock: MPEG-TS fixtures start 1.4 s after fMP4.
        const bytes =
          audio && alignClocks && folder.endsWith('ts')
            ? shiftTsTimestamps(original, -1.4)
            : original;
        const body = clear ? bytes : encrypt(bytes, seq + BigInt(index));
        routes[`/${prefix}/${line}`] = (_, res) => sendBytes(res, body);
        index++;
        return [clear ? '#EXT-X-KEY:METHOD=NONE' : '#EXT-X-KEY:METHOD=AES-128,URI="/key"', line];
      })
      .join('\n');
    for (const name of names.filter((n) => n.startsWith('init.')))
      routes[`/${prefix}/${name}`] = (_, res) =>
        sendBytes(res, encrypt(readFileSync(resolve(base, name)), 1n));
    routes[`/${prefix}/media.m3u8`] = (_, res) => sendText(res, playlist);
  }
  return routes;
}
