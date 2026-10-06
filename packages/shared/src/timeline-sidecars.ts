import { HlsDownloaderError, HlsDownloaderErrorCode as Code } from './errors';
import type {
  HlsChapterOptions,
  HlsMediaTime,
  HlsSidecar,
  HlsTimelineMapping,
  HlsTimelineReport,
  HlsTimelineTrackSelection,
} from './timeline';
type Rational = { n: bigint; d: bigint };
const invalid = (): never => {
  throw new HlsDownloaderError(Code.SUBTITLE_INVALID, 'Invalid or ambiguous sidecar timeline');
};
const time = (t: HlsMediaTime): Rational => {
  if (
    !t ||
    typeof t.ticks !== 'string' ||
    !/^(0|-?[1-9]\d*)$/.test(t.ticks) ||
    !Number.isInteger(t.timescale) ||
    t.timescale <= 0 ||
    t.timescale > 0xffffffff
  )
    return invalid();
  return { n: BigInt(t.ticks), d: BigInt(t.timescale) };
};
const add = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const sub = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const cmp = (a: Rational, b: Rational): number =>
  a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
const max = (a: Rational, b: Rational): Rational => (cmp(a, b) >= 0 ? a : b);
const min = (a: Rational, b: Rational): Rational => (cmp(a, b) <= 0 ? a : b);
const zero: Rational = { n: 0n, d: 1n };
function mappings(
  report: HlsTimelineReport,
  track?: HlsTimelineTrackSelection,
): HlsTimelineMapping[] {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.outputs) || !report.outputs.length)
    invalid();
  const all = report.outputs.flatMap((o) => o.mappings);
  if (!track) {
    const video = all.find(
      (m) =>
        m.inputId === 'primary' &&
        /avc|hevc|h264|h265/i.test(
          report.outputs.find((o) => o.index === m.outputIndex)?.tracks[m.trackId - 1]?.codec ?? '',
        ),
    );
    const selected =
      video ?? all.find((m) => m.inputId === 'primary') ?? all.find((m) => m.inputId === 'audio');
    if (!selected) return invalid();
    track = { inputId: selected.inputId, trackId: selected.trackId };
  }
  const selected = all.filter((m) => m.inputId === track!.inputId && m.trackId === track!.trackId);
  if (!selected.length) invalid();
  for (const m of selected) {
    if (cmp(time(m.presentation.start), time(m.presentation.end)) >= 0) invalid();
    time(m.outputStart);
    time(m.sourceOrigin);
  }
  return selected;
}
function stamp(value: Rational, ceil = false): string {
  value = max(value, zero);
  let ms = (value.n * 1000n) / value.d;
  if (ceil && (value.n * 1000n) % value.d) ms++;
  return `${(ms / 3600000n).toString().padStart(2, '0')}:${((ms / 60000n) % 60n).toString().padStart(2, '0')}:${((ms / 1000n) % 60n).toString().padStart(2, '0')}.${(ms % 1000n).toString().padStart(3, '0')}`;
}
type Cue = { start: Rational; end: Rational; body: string; id: string; settings: string };
function put(
  cues: Map<string, Cue[]>,
  m: HlsTimelineMapping,
  start: Rational,
  end: Rational,
  cue: Omit<Cue, 'start' | 'end'>,
): void {
  const a = max(start, time(m.presentation.start)),
    b = min(end, time(m.presentation.end));
  if (cmp(a, b) >= 0) return;
  const offset = sub(time(m.outputStart), time(m.presentation.start));
  const list = cues.get(m.outputIndex) ?? [];
  list.push({ ...cue, start: add(a, offset), end: add(b, offset) });
  cues.set(m.outputIndex, list);
}
function render(
  report: HlsTimelineReport,
  cues: Map<string, Cue[]>,
  filename: string,
  metadata: string[] = [],
): HlsSidecar[] {
  const base = filename.replace(/\.vtt$/i, '');
  return report.outputs.map((o) => {
    const seen = new Set<string>();
    const lines = (cues.get(o.index) ?? [])
      .sort((a, b) => cmp(a.start, b.start))
      .map(
        (c) =>
          `${c.id ? c.id + '\n' : ''}${stamp(c.start)} --> ${stamp(c.end, true)}${c.settings}\n${c.body}`,
      )
      .filter((c) => {
        if (seen.has(c)) return false;
        seen.add(c);
        return true;
      });
    return {
      outputIndex: o.index,
      filename: `${base}.${(BigInt(o.index) + 1n).toString().padStart(3, '0')}.vtt`,
      mimeType: 'text/vtt',
      text: ['WEBVTT', ...metadata, ...lines].join('\n\n') + '\n',
    };
  });
}
/** Export caller-supplied presentation intervals on each output's media clock. */
export function exportChapters(options: HlsChapterOptions): HlsSidecar[] {
  const selected = mappings(options.timelineReport, options.track),
    cues = new Map<string, Cue[]>();
  for (const c of options.chapters) {
    const start = time(c.range.start),
      end = time(c.range.end);
    if (
      cmp(start, zero) < 0 ||
      cmp(start, end) >= 0 ||
      typeof c.title !== 'string' ||
      !c.title.trim() ||
      /[\r\n]/.test(c.id ?? '') ||
      (c.id ?? '').includes('-->')
    )
      invalid();
    const title = c.title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/[\r\n]+/g, ' ');
    for (const m of selected)
      put(cues, m, start, end, { body: title, id: c.id ?? '', settings: '' });
  }
  return render(options.timelineReport, cues, options.filename ?? 'chapters');
}
export type HlsWebVttPart = {
  text: string;
  header?: string;
  epoch: string;
  programDateTime: string | null;
  duration: HlsMediaTime;
};
function parseStamp(s: string): Rational {
  const m = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(s);
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) return invalid();
  return {
    n: ((BigInt(m[1] ?? 0) * 60n + BigInt(m[2]!)) * 60n + BigInt(m[3]!)) * 1000n + BigInt(m[4]!),
    d: 1000n,
  };
}
/** Map clear WebVTT resources using media clocks; epoch sequence numbers are not clocks. */
export function mapTimelineWebVtt(
  parts: readonly HlsWebVttPart[],
  report: HlsTimelineReport,
  track?: HlsTimelineTrackSelection,
  filename = 'subtitles',
): HlsSidecar[] {
  const selected = mappings(report, track),
    cues = new Map<string, Cue[]>(),
    metadata = new Set<string>();
  let previousEpoch: string | undefined, selectedEpoch: string | undefined;
  for (const part of parts) {
    let text = part.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) {
      if (!part.header) invalid();
      text = part.header!.trimEnd() + '\n\n' + text;
    }
    const blocks = text.trim().split(/\n[ \t]*\n/);
    const header = blocks.shift()!;
    const maps = header.split('\n').filter((l) => l.startsWith('X-TIMESTAMP-MAP'));
    if (maps.length > 1) invalid();
    let local = zero,
      raw = 0n;
    if (maps.length) {
      const l = /(?:=|,)LOCAL:([^,]+)/.exec(maps[0]!),
        r = /(?:=|,)MPEGTS:(\d+)/.exec(maps[0]!);
      if (!l || !r) invalid();
      local = parseStamp(l![1]!);
      raw = BigInt(r![1]!);
      if (raw >= 1n << 33n) invalid();
    }
    const parsed: Cue[] = [];
    for (const block of blocks) {
      if (/^NOTE(?:[ \t\n]|$)/.test(block)) continue;
      if (/^(STYLE|REGION)(?:\n|$)/.test(block)) {
        metadata.add(block);
        continue;
      }
      const lines = block.split('\n');
      const id = lines[0]!.includes('-->') ? '' : lines.shift()!;
      const m = /^(\S+)\s+-->\s+(\S+)(.*)$/.exec(lines.shift() ?? '');
      if (!m) invalid();
      const start = parseStamp(m![1]!),
        end = parseStamp(m![2]!);
      if (cmp(start, end) >= 0) invalid();
      parsed.push({ start, end, id, settings: m![3]!, body: lines.join('\n') });
    }
    const candidates = new Map<string, { m: HlsTimelineMapping; offset: Rational }[]>();
    for (const m of selected) {
      const anchor = time(m.wrapAnchor ?? m.sourceOrigin);
      const anchor90 = (anchor.n * 90000n) / anchor.d;
      const period = 1n << 33n;
      let delta = (((raw - anchor90) % period) + period) % period;
      if (delta === period / 2n) invalid();
      if (delta > period / 2n) delta -= period;
      const source = { n: anchor90 + delta, d: 90000n };
      const offset = add(sub(time(m.presentation.start), time(m.sourceOrigin)), sub(source, local));
      // PDT disambiguates repeated source timestamps across resets without equating rendition sequence numbers.
      if (part.programDateTime && m.programDateTime) {
        const p = Date.parse(part.programDateTime),
          q = Date.parse(m.programDateTime);
        if (!Number.isFinite(p) || !Number.isFinite(q)) invalid();
        const duration = time(part.duration);
        const difference = { n: BigInt(p - q), d: 1000n };
        const span = sub(time(m.presentation.end), time(m.presentation.start));
        if (cmp(add(difference, duration), zero) <= 0 || cmp(difference, span) >= 0) continue;
      }
      if (
        parsed.some(
          (c) =>
            cmp(add(c.end, offset), time(m.presentation.start)) > 0 &&
            cmp(add(c.start, offset), time(m.presentation.end)) < 0,
        )
      ) {
        const list = candidates.get(m.epoch) ?? [];
        list.push({ m, offset });
        candidates.set(m.epoch, list);
      }
    }
    if (part.epoch !== previousEpoch) selectedEpoch = undefined;
    if (selectedEpoch && candidates.has(selectedEpoch)) {
      for (const key of candidates.keys()) if (key !== selectedEpoch) candidates.delete(key);
    }
    if (candidates.size > 1) invalid();
    const candidate = candidates.entries().next().value as
      | [string, { m: HlsTimelineMapping; offset: Rational }[]]
      | undefined;
    if (candidate) {
      selectedEpoch = candidate[0];
      for (const { m, offset } of candidate[1])
        for (const c of parsed) put(cues, m, add(c.start, offset), add(c.end, offset), c);
    }
    previousEpoch = part.epoch;
  }
  return render(report, cues, filename, [...metadata]);
}
