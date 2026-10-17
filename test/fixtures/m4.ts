import { encryptedRoutes, key } from './encrypted';
import { packedRoutes, packedKey } from './multitrack';
import { timelineCases, timelineRoutes, timelineOptions } from './timeline';
import { sendBytes, sendText, type FixtureHandler } from './http-server';
import { createCipheriv } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
export const m4Profiles: {
  name: string;
  routes: () => Record<string, FixtureHandler>;
  url: string;
  options: any;
}[] = [];
for (const format of ['ts', 'fmp4'])
  for (const selected of [false, true])
    m4Profiles.push({
      name: `AES-128 ${format} ${selected ? 'selected' : 'single'} range/MAP/NONE/sequence`,
      routes: () => encryptedRoutes(format, selected, true),
      url: selected ? '/master.m3u8' : '/video/media.m3u8',
      options: {
        ...(selected ? { audio: { groupId: 'a', name: 'en' } } : {}),
        timeline: {
          range: {
            start: { ticks: '200', timescale: 1000 },
            end: { ticks: '1800', timescale: 1000 },
          },
        },
        decryption: { keyResolver: async () => ({ key, version: 'aes-v1' }) },
      },
    });
for (const c of timelineCases.filter(
  (c) =>
    (c.name.startsWith('sample-') || ['range-True', 'dual-True'].includes(c.name)) &&
    !c.selection.split,
)) {
  const opts = timelineOptions(c);
  m4Profiles.push({
    name: c.name,
    routes: () => timelineRoutes(c),
    url: '/master.m3u8',
    options: {
      ...opts,
      decryption: {
        ...opts.decryption,
        keyResolver: async (r: any) => ({
          ...(await opts.decryption.keyResolver(r)),
          version: 'sample-v1',
        }),
      },
    },
  });
}
for (const kind of ['clear', 'aes128', 'aes128_rotation', 'sample_aes', 'sample_aes_rotation'])
  m4Profiles.push({
    name: `Packed AAC ${kind}`,
    routes: () => packedRoutes(kind),
    url: '/input.m3u8',
    options: {
      timeline: {
        range: {
          start: { ticks: '100', timescale: 1000 },
          end: { ticks: '1100', timescale: 1000 },
        },
      },
      decryption: {
        keyResolver: async (r: any) => ({
          key: packedKey(r.uri),
          version: r.uri.includes('rotated') ? 'packed-v2' : 'packed-v1',
        }),
      },
    },
  });

// Independent OpenSSL GCM fixtures, including alternate audio and encrypted MAP.
for (const format of ['ts', 'fmp4', 'packed'])
  for (const selected of [false, true]) {
    const secret = Buffer.alloc(32, 7),
      iv = Buffer.alloc(16, 3);
    m4Profiles.push({
      name: `GCM ${format} ${selected ? 'selected' : 'single'}`,
      url: selected ? '/master.m3u8' : '/video/input.m3u8',
      options: {
        decryption: {
          experimentalGcm: true,
          keyResolver: async () => ({ key: secret, version: 'gcm-v1' }),
        },
      },
      routes() {
        const routes: Record<string, FixtureHandler> = {
          '/master.m3u8': (_, res) =>
            sendText(
              res,
              '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio/input.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a"\nvideo/input.m3u8\n',
            ),
        };
        for (const [prefix, folder] of [
          [
            'video',
            format === 'packed' ? (selected ? 'media/ts' : 'packed-aac/clear') : 'media/' + format,
          ],
          ...(selected
            ? [['audio', format === 'packed' ? 'packed-aac/clear' : 'media/audio-fmp4']]
            : []),
        ]) {
          const root = resolve(import.meta.dirname, folder!);
          for (const name of readdirSync(root)) {
            const bytes = readFileSync(resolve(root, name));
            if (name.endsWith('.m3u8'))
              routes[`/${prefix}/input.m3u8`] = (_, res) =>
                sendText(
                  res,
                  bytes
                    .toString()
                    .replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-256-GCM,URI="/key"'),
                );
            else {
              const cipher = createCipheriv('aes-256-gcm', secret, iv);
              const encrypted = Buffer.concat([
                iv,
                cipher.update(bytes),
                cipher.final(),
                cipher.getAuthTag(),
              ]);
              routes[`/${prefix}/${name}`] = (_, res) => sendBytes(res, encrypted);
            }
          }
        }
        return routes;
      },
    });
  }
