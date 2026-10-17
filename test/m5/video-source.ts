import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { realtimeWindow } from './realtime.ts';

export const videoSeconds = 2.56; // 64 video frames at 25 fps / 120 AAC frames at 48 kHz.
function boxes(
  bytes: Buffer,
  start = 0,
  end = bytes.length,
): { type: string; start: number; end: number }[] {
  const result = [];
  while (start < end) {
    const size = bytes.readUInt32BE(start);
    if (size < 8 || start + size > end) throw Error('Invalid fixture MP4 box');
    result.push({ type: bytes.toString('ascii', start + 4, start + 8), start, end: start + size });
    start += size;
  }
  return result;
}
export function shiftFragment(template: Buffer, sequence: number, timescale: number) {
  const bytes = Buffer.from(template);
  for (const moof of boxes(bytes).filter((b) => b.type === 'moof')) {
    for (const child of boxes(bytes, moof.start + 8, moof.end)) {
      if (child.type === 'mfhd') bytes.writeUInt32BE(sequence + 1, child.start + 12);
      if (child.type !== 'traf') continue;
      for (const box of boxes(bytes, child.start + 8, child.end).filter((b) => b.type === 'tfdt')) {
        const ticks = BigInt(Math.round(sequence * videoSeconds * timescale));
        if (bytes[box.start + 8] === 1) bytes.writeBigUInt64BE(ticks, box.start + 12);
        else bytes.writeUInt32BE(Number(ticks), box.start + 12);
      }
    }
  }
  return bytes;
}
export async function startVideoSource(
  directory: string,
  durationMs: number,
  mode: 'live' | 'event',
) {
  mkdirSync(directory);
  const tracks = ['video', 'en', 'fr'].map((id, i) => {
    const file = join(directory, `${id}.mp4`);
    const args =
      i === 0
        ? [
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=1280x720:rate=25',
            '-frames:v',
            '64',
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-pix_fmt',
            'yuv420p',
            '-b:v',
            '4M',
            '-minrate',
            '4M',
            '-maxrate',
            '4M',
            '-bufsize',
            '8M',
            '-x264-params',
            'nal-hrd=cbr',
            '-g',
            '64',
            '-keyint_min',
            '64',
            '-sc_threshold',
            '0',
            '-video_track_timescale',
            '90000',
          ]
        : [
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=${i * 440}:sample_rate=48000`,
            '-frames:a',
            '119', // AAC encoder emits one additional priming frame.
            '-vn',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
          ];
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        ...args,
        '-movflags',
        'empty_moov+default_base_moof',
        '-f',
        'mp4',
        file,
      ],
      { timeout: 60_000 },
    );
    const bytes = readFileSync(file),
      top = boxes(bytes),
      moof = top.find((b) => b.type === 'moof')!;
    if (!moof || top.filter((b) => b.type === 'moof').length !== 1)
      throw Error('Expected single fixture fragment');
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], {
        encoding: 'utf8',
      }),
    );
    const timescale = Number(probe.streams[0].time_base.split('/')[1]);
    if (Math.abs(Number(probe.streams[0].duration) - videoSeconds) > 0.00001)
      throw Error(`Unexpected ${id} fixture duration: ${probe.streams[0].duration}`);
    return {
      id,
      init: bytes.subarray(0, moof.start),
      fragment: Buffer.concat(
        top
          .filter((b) => ['moof', 'mdat'].includes(b.type))
          .map((b) => bytes.subarray(b.start, b.end)),
      ),
      timescale,
    };
  });
  let requests = 0;
  const clocks = new Map<string, number>();
  const server = createServer((req, res) => {
    requests++;
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      const [, operation, resource] =
        /^\/([\w-]+)\/([^/]+)$/.exec(new URL(req.url!, 'http://fixture').pathname) ?? [];
      if (!operation || !resource) {
        res.writeHead(404).end();
        return;
      }
      if (resource === 'master.m3u8') {
        res.end(
          '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="French",LANGUAGE="fr",URI="fr.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="subs.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,AUDIO="a",SUBTITLES="s"\nvideo.m3u8\n',
        );
        return;
      }
      clocks.set(operation, clocks.get(operation) ?? performance.now());
      const window = realtimeWindow(
        performance.now() - clocks.get(operation)!,
        durationMs,
        mode,
        4,
        videoSeconds,
      );
      if (resource.endsWith('.m3u8')) {
        const id = resource.replace('.m3u8', '');
        let text = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:${window.start}\n`;
        if (mode === 'event') text += '#EXT-X-PLAYLIST-TYPE:EVENT\n';
        if (id !== 'subs') text += `#EXT-X-MAP:URI="${id}-init"\n`;
        for (let n = window.start; n < window.end; n++)
          text += `#EXTINF:${videoSeconds},\n${id}-${n}\n`;
        if (window.endList) text += '#EXT-X-ENDLIST\n';
        res.end(text);
        return;
      }
      const [id, index] = resource.split('-');
      if (id === 'subs') {
        res.end(
          `WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:${Math.round(Number(index) * videoSeconds * 90000)}\n\ncue-${index}\n00:00.050 --> 00:00.300\nCaption ${index}\n\n`,
        );
        return;
      }
      const track = tracks.find((t) => t.id === id);
      if (!track) {
        res.writeHead(404).end();
        return;
      }
      res.end(
        index === 'init'
          ? track.init
          : shiftFragment(track.fragment, Number(index), track.timescale),
      );
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing video fixture port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
