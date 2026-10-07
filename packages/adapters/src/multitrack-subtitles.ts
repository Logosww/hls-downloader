import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type HlsMediaTime,
} from '@hls-downloader/shared';

export type EmbeddedCue = {
  generation: string;
  epoch: string;
  start: HlsMediaTime;
  end: HlsMediaTime;
  identifier: string;
  payload: string;
  settings: string;
};
const invalid = (reason: string) =>
  new HlsDownloaderError(Code.SUBTITLE_INVALID, 'Invalid embedded WebVTT', { reason });
const unsupported = () =>
  new HlsDownloaderError(Code.UNSUPPORTED_RENDITION, 'Unsupported embedded WebVTT profile', {
    reason: 'UnsupportedSubtitleProfile',
  });
const period = 1n << 33n;
export function unwrapWebVttTimestamp(raw: bigint, reference?: bigint): bigint {
  if (raw < 0n || raw >= period) throw invalid('TimestampMap');
  if (reference === undefined) return raw;
  let delta = (((raw - reference) % period) + period) % period;
  if (delta === period / 2n) throw invalid('AmbiguousWrap');
  if (delta > period / 2n) delta -= period;
  return reference + delta;
}
function timestamp(text: string): bigint {
  const m = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(text);
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) throw invalid('Timestamp');
  return ((BigInt(m[1] ?? 0) * 60n + BigInt(m[2]!)) * 60n + BigInt(m[3]!)) * 1000n + BigInt(m[4]!);
}
function settings(text: string): void {
  if (/[^\S \t]/u.test(text)) throw unsupported();
  const seen = new Set<string>();
  const percent = (s: string) => /^\d+(?:\.\d+)?%$/.test(s) && Number(s.slice(0, -1)) <= 100;
  const line = (s: string) =>
    percent(s) || (/^-?\d+$/.test(s) && BigInt(s) >= -2147483648n && BigInt(s) <= 2147483647n);
  for (const setting of text.split(/[ \t]+/).filter(Boolean)) {
    const i = setting.indexOf(':');
    const key = setting.slice(0, i),
      value = setting.slice(i + 1);
    if (i < 0 || seen.has(key)) throw unsupported();
    seen.add(key);
    const [p, a, extra] = value.split(',');
    let valid = false;
    if (key === 'align') valid = ['start', 'center', 'end', 'left', 'right'].includes(value);
    if (key === 'vertical') valid = ['rl', 'lr'].includes(value);
    if (key === 'size') valid = percent(value);
    if (key === 'position')
      valid = percent(p!) && (a === undefined || ['line-left', 'center', 'line-right'].includes(a));
    if (key === 'line')
      valid = line(p!) && (a === undefined || ['start', 'center', 'end'].includes(a));
    if (!valid || extra !== undefined) throw unsupported();
  }
}
/** Decode onto the bound media source clock. EXTINF and sequence numbers are never clocks. */
export function parseEmbeddedWebVtt(
  text: string,
  context: {
    generation: string;
    epoch: string;
    reference?: bigint;
    header?: string;
  },
): { cues: EmbeddedCue[]; reference: bigint } {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) {
    if (!context.header) throw invalid('MissingHeader');
    text =
      context.header
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trimEnd() +
      '\n\n' +
      text;
  }
  const blocks = text.trimEnd().split(/\n[ \t]*\n/);
  const header = blocks.shift()!;
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(header) || text.includes('\0')) throw invalid('Header');
  const maps = header.split('\n').filter((l) => l.startsWith('X-TIMESTAMP-MAP'));
  if (maps.length > 1) throw invalid('TimestampMap');
  let local = 0n,
    raw = 0n;
  if (maps.length) {
    const fields = maps[0]!.replace(/^X-TIMESTAMP-MAP=/, '').split(',');
    const l = fields.find((f) => f.startsWith('LOCAL:'))?.slice(6);
    const r = fields.find((f) => f.startsWith('MPEGTS:'))?.slice(7);
    if (fields.length !== 2 || !l || !r || !/^\d+$/.test(r)) throw invalid('TimestampMap');
    local = timestamp(l);
    raw = BigInt(r);
  }
  const anchor = unwrapWebVttTimestamp(raw, context.reference);
  const cues: EmbeddedCue[] = [];
  for (const block of blocks) {
    if (/^NOTE(?:[ \t\n]|$)/.test(block)) continue;
    if (/^(STYLE|REGION)(?:[ \t\n]|$)/.test(block)) throw unsupported();
    const lines = block.split('\n');
    const identifier = lines[0]!.includes('-->') ? '' : lines.shift()!;
    const m = /^(\S+)[ \t]+-->[ \t]+(\S+)(.*)$/.exec(lines.shift() ?? '');
    if (!m) throw invalid('Cue');
    const start = anchor + (timestamp(m[1]!) - local) * 90n;
    const end = anchor + (timestamp(m[2]!) - local) * 90n;
    if (end <= start) throw invalid('Interval');
    const payload = lines.join('\n'),
      cueSettings = m[3]!.trim();
    if (/[<>]/.test(payload)) throw unsupported();
    settings(cueSettings);
    cues.push({
      generation: context.generation,
      epoch: context.epoch,
      start: { ticks: start.toString(), timescale: 90000 },
      end: { ticks: end.toString(), timescale: 90000 },
      identifier,
      payload,
      settings: cueSettings,
    });
  }
  return { cues, reference: anchor };
}
