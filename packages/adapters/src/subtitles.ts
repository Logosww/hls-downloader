import { HlsDownloaderError, HlsDownloaderErrorCode } from '@hls-downloader/shared';
export type SubtitleTimeline = {
  origin: { ticks: string; timescale: number };
  tracks: { wrapAnchor?: string | null }[];
};
const invalid = () =>
  new HlsDownloaderError(
    HlsDownloaderErrorCode.SUBTITLE_INVALID,
    'Invalid or ambiguous WebVTT timeline',
  );
function timestamp(value: string): bigint {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw invalid();
  return (
    ((BigInt(match[1] ?? 0) * 60n + BigInt(match[2]!)) * 60n + BigInt(match[3]!)) * 1000n +
    BigInt(match[4]!)
  );
}
function format(value: bigint): string {
  return `${(value / 3600000n).toString().padStart(2, '0')}:${((value / 60000n) % 60n).toString().padStart(2, '0')}:${((value / 1000n) % 60n).toString().padStart(2, '0')}.${(value % 1000n).toString().padStart(3, '0')}`;
}
/** Merge HLS WebVTT segments on the prepared output timeline using exact integer arithmetic. */
export function mergeWebVtt(
  parts: { text: string; header?: string; duration: number }[],
  timeline: SubtitleTimeline,
): string {
  const scale = BigInt(timeline.origin.timescale),
    origin = BigInt(timeline.origin.ticks);
  const period = 1n << 33n;
  let reference = BigInt(
    timeline.tracks.find((t) => t.wrapAnchor != null)?.wrapAnchor ??
      ((origin * 90000n) / scale).toString(),
  );
  const cues: { start: bigint; end: bigint; body: string; id: string; settings: string }[] = [];
  const seen = new Set<string>(),
    metadata = new Set<string>();
  for (const part of parts) {
    let text = part.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!/^WEBVTT(?:[ \t].*)?\n/.test(text + '\n')) {
      if (!part.header) throw invalid();
      text = part.header.replace(/\r\n?/g, '\n').trimEnd() + '\n\n' + text;
    }
    const blocks = text.trim().split(/\n[ \t]*\n/);
    const header = blocks.shift()!;
    if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(header)) throw invalid();
    let local = 0n,
      raw = 0n;
    const map = header.split('\n').find((l) => l.startsWith('X-TIMESTAMP-MAP'));
    if (map) {
      const l = /(?:=|,)LOCAL:([^,]+)/.exec(map),
        m = /(?:=|,)MPEGTS:(\d+)/.exec(map);
      if (!l || !m) throw invalid();
      local = timestamp(l[1]!);
      raw = BigInt(m[1]!);
      if (raw >= period) throw invalid();
    }
    let delta = (((raw - reference) % period) + period) % period;
    if (delta === period / 2n) throw invalid();
    if (delta > period / 2n) delta -= period;
    const anchor = reference + delta;
    const convert = (ms: bigint) =>
      ((anchor * scale - origin * 90000n) * 1000n + (ms - local) * 90000n * scale) /
      (90000n * scale);
    for (const block of blocks) {
      if (/^NOTE(?:[ \t\n]|$)/.test(block)) continue;
      if (/^(STYLE|REGION)(?:\n|$)/.test(block)) {
        metadata.add(block);
        continue;
      }
      const lines = block.split('\n');
      const id = lines[0]!.includes('-->') ? '' : lines.shift()!;
      const match = /^(\S+)\s+-->\s+(\S+)(.*)$/.exec(lines.shift() ?? '');
      if (!match) throw invalid();
      const startRaw = timestamp(match[1]!),
        endRaw = timestamp(match[2]!);
      if (endRaw <= startRaw) throw invalid();
      const end = convert(endRaw),
        start = convert(startRaw);
      if (end <= 0n) continue;
      const cue = {
        start: start < 0n ? 0n : start,
        end,
        body: lines.join('\n'),
        id,
        settings: match[3]!,
      };
      const key = [cue.start, cue.end, cue.body, id, cue.settings].join('\0');
      if (!seen.has(key)) {
        seen.add(key);
        cues.push(cue);
      }
    }
    // Advance even for empty segments, using playlist progression only to choose the wrap epoch.
    reference += BigInt(Math.round(part.duration * 90000));
  }
  cues.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return (
    [
      'WEBVTT',
      ...metadata,
      ...cues.map(
        (c) =>
          `${c.id ? c.id + '\n' : ''}${format(c.start)} --> ${format(c.end)}${c.settings}\n${c.body}`,
      ),
    ].join('\n\n') + '\n'
  );
}
