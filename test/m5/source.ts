import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createCipheriv } from 'node:crypto';
import { realtimeWindow, segmentSeconds } from './realtime.ts';

// Constant-size synthetic source: no request log, media cache or growing route map.
// Reuse independently generated AAC frames, replacing only the ID3 clock anchor.
const template = readFileSync(new URL('../fixtures/packed-aac/clear/seg0.bin', import.meta.url));
const anchor = template.indexOf(Buffer.from('com.apple.streaming.transportStreamTimestamp\0')) + 45;
if (anchor !== 65) throw Error('Unexpected Packed AAC fixture');
export { segmentSeconds };
export const testKey = Buffer.alloc(16, 7);

export async function startSource(
  count: number,
  batch = 16,
  rewriteSubtitleKey?: 'uri' | 'iv',
  realtime?: { durationMs: number; mode: 'live' | 'event' },
  faults?: { failEvery?: number; cumulative?: boolean },
) {
  let requests = 0;
  let failures = 0;
  const cursors = new Map<string, number>();
  const clocks = new Map<string, number>();
  const keyFor = (n: number) => (realtime ? Buffer.alloc(16, n % 2 ? 9 : 7) : testKey);
  const server = createServer(async (req, res) => {
    requests++;
    const path = new URL(req.url!, 'http://fixture').pathname;
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      const match =
        /^\/([\w-]+)\/(master\.m3u8|media\.m3u8|subs\.m3u8|(?:media|sub|key)-\d+)$/.exec(path);
      if (!match) {
        res.writeHead(404).end();
        return;
      }
      const [, operation, resource] = match;
      if (faults?.failEvery && requests % faults.failEvery === 0) {
        failures++;
        res.writeHead(503).end('M5 injected transient failure');
        return;
      }
      if (resource === 'master.m3u8') {
        res.end(
          '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="subs.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=64000,SUBTITLES="s"\nmedia.m3u8\n',
        );
      } else if (resource!.endsWith('.m3u8')) {
        const cursorKey = operation + resource!;
        if (!clocks.has(operation!)) clocks.set(operation!, performance.now());
        const window =
          realtime &&
          realtimeWindow(
            performance.now() - clocks.get(operation!)!,
            realtime.durationMs,
            realtime.mode,
            batch,
          );
        const cursor = Math.min(cursors.get(cursorKey) ?? 0, Math.max(0, count - batch));
        const start = window ? window.start : faults?.cumulative ? 0 : cursor;
        const end = window ? window.end : Math.min(count, cursor + batch);
        if (!realtime) cursors.set(cursorKey, cursor + batch / 2);
        const kind = resource === 'subs.m3u8' ? 'sub' : 'media';
        let playlist = `#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${start}\n`;
        if (realtime?.mode === 'event' || faults?.cumulative)
          playlist += '#EXT-X-PLAYLIST-TYPE:EVENT\n';
        for (let i = start; i < end; i++) {
          const rewrite = kind === 'sub' && start > 0 && i === start;
          const keyIndex = rewrite && rewriteSubtitleKey === 'uri' ? i + 1 : i;
          const iv =
            rewrite && rewriteSubtitleKey === 'iv' ? ',IV=0x000000000000000000000000000000ff' : '';
          playlist += `#EXT-X-KEY:METHOD=AES-128,URI="key-${keyIndex}"${iv}\n#EXTINF:${segmentSeconds.toFixed(9)},\n${kind}-${i}\n`;
        }
        if (window ? window.endList : end === count) playlist += '#EXT-X-ENDLIST\n';
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.end(playlist);
      } else {
        const n = Number(resource!.split('-')[1]);
        if (n >= count) {
          res.writeHead(404).end();
          return;
        }
        if (resource!.startsWith('key-')) {
          res.end(keyFor(n));
          return;
        }
        const ticks = BigInt(Math.round(n * segmentSeconds * 90000));
        let bytes: Buffer;
        if (resource!.startsWith('media-')) {
          bytes = Buffer.from(template);
          bytes.writeBigUInt64BE(ticks % (1n << 33n), anchor);
        } else {
          bytes = Buffer.from(
            `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:${ticks}\n\ncue-${n}\n00:00.050 --> 00:00.300\nCaption ${n}\n\n`,
          );
        }
        const iv = Buffer.alloc(16);
        iv.writeBigUInt64BE(BigInt(n), 8);
        const cipher = createCipheriv('aes-128-cbc', keyFor(n), iv);
        if (n % 17 === 0) await new Promise((r) => setTimeout(r, 15));
        res.end(Buffer.concat([cipher.update(bytes), cipher.final()]));
      }
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No fixture port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests;
    },
    get failures() {
      return failures;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
