import type { HlsEngineReport } from './multitrack';
import type { HlsRecordingEvent } from './recording';
import type {
  HlsMediaTime,
  HlsPresentationRange,
  HlsTimelineMap,
  HlsTimelineMapping,
} from './timeline';
const gcd = (a: bigint, b: bigint): bigint => (b ? gcd(b, a % b) : a < 0n ? -a : a);
function sum(a: HlsMediaTime, b: HlsMediaTime, sign = 1n): HlsMediaTime {
  const n = BigInt(a.ticks) * BigInt(b.timescale) + sign * BigInt(b.ticks) * BigInt(a.timescale);
  const d = BigInt(a.timescale) * BigInt(b.timescale),
    g = gcd(n, d);
  if (d / g > 4294967295n) throw Error('Time overflow');
  return { ticks: (n / g).toString(), timescale: Number(d / g) };
}
const compare = (a: HlsMediaTime, b: HlsMediaTime): number => {
  const n = BigInt(a.ticks) * BigInt(b.timescale) - BigInt(b.ticks) * BigInt(a.timescale);
  return n < 0n ? -1 : n > 0n ? 1 : 0;
};
/** Capture bounded mapping evidence, independently of user observers. */
export function createTimelineRecorder(limit: number, collapse: boolean) {
  const gaps: Extract<HlsRecordingEvent, { type: 'gap' }>[] = [];
  let truncated = false;
  return {
    event(event: HlsRecordingEvent): void {
      if (event.type !== 'gap') return;
      if (gaps.length >= limit) {
        truncated = true;
        return;
      }
      gaps.push(event);
    },
    finish(report: HlsEngineReport): HlsTimelineMap {
      const result: HlsTimelineMap = {
        schemaVersion: 2,
        complete: !truncated && !report.historyTruncated && !report.trackHistoryTruncated,
        outputs: [],
        gaps: gaps.map((g) => ({
          start: g.presentationStart,
          end: sum(g.presentationStart, g.duration),
        })),
      };
      if (BigInt(report.gapCount) > BigInt(gaps.length)) result.complete = false;
      try {
        let count = 0;
        for (const output of report.outputs) {
          const mappings: HlsTimelineMapping[] = [];
          const entries = report.mappings.filter((m) => m.outputIndex === output.index);
          for (const m of entries) {
            const selectedTrack = report.tracks.find(
              (t) =>
                t.outputIndex === output.index && t.id === m.trackId && t.inputId === m.inputId,
            );
            if (selectedTrack?.kind === 'subtitle') continue;
            const track =
              selectedTrack &&
              output.tracks[
                report.tracks.filter((t) => t.outputIndex === output.index).indexOf(selectedTrack)
              ];
            if (!track) {
              result.complete = false;
              continue;
            }
            const trackEntries = entries.filter(
              (n) => n.trackId === m.trackId && n.inputId === m.inputId,
            );
            if (selectedTrack?.kind === 'audio' && trackEntries.length === 1 && !gaps.length) {
              const span = sum(
                { ticks: selectedTrack.duration, timescale: selectedTrack.timescale },
                m.outputStart,
                -1n,
              );
              const expected = BigInt(selectedTrack.sampleCount) * 1024n;
              const actual =
                (BigInt(span.ticks) * BigInt(selectedTrack.timescale)) / BigInt(span.timescale);
              if (actual < expected - 1n || actual > expected + 1n) result.complete = false;
            }
            const next = entries.find(
              (n) =>
                n !== m &&
                n.trackId === m.trackId &&
                n.inputId === m.inputId &&
                compare(n.presentationStart, m.presentationStart) > 0,
            );
            let end =
              next?.presentationStart ??
              sum(
                m.presentationStart,
                sum({ ticks: track.duration, timescale: track.timescale }, m.outputStart, -1n),
              );
            const relevant = gaps
              .filter(
                (g) =>
                  g.slot.inputId === m.inputId &&
                  g.slot.generation === m.generation &&
                  g.slot.epoch === m.epoch,
              )
              .sort((a, b) => compare(a.presentationStart, b.presentationStart));
            if (collapse && !next)
              for (const g of relevant)
                if (
                  compare(g.presentationStart, m.presentationStart) >= 0 &&
                  compare(g.presentationStart, end) <= 0
                )
                  end = sum(end, g.duration);
            let start = m.presentationStart,
              outputStart = m.outputStart;
            const put = (last: HlsMediaTime) => {
              if (compare(start, last) >= 0) return;
              if (++count > limit) {
                result.complete = false;
                return;
              }
              mappings.push({
                inputId: m.inputId,
                trackId: m.trackId,
                epoch: m.epoch,
                sourceOrigin:
                  compare(start, m.presentationStart) === 0
                    ? m.sourceStart
                    : sum(m.sourceStart, sum(start, m.presentationStart, -1n)),
                sourceDecodeStart: m.sourceStart,
                configurationId: m.configurationId,
                presentation: { start, end: last },
                outputStart,
                outputIndex: m.outputIndex,
                wrapAnchor: m.sourceStart,
                programDateTime: m.programDateTime,
              });
            };
            for (const g of relevant) {
              const gapEnd = sum(g.presentationStart, g.duration);
              if (compare(gapEnd, start) <= 0 || compare(g.presentationStart, end) >= 0) continue;
              const before = compare(g.presentationStart, start) > 0 ? g.presentationStart : start;
              put(before);
              outputStart = sum(outputStart, sum(before, start, -1n));
              if (!collapse) outputStart = sum(outputStart, sum(gapEnd, before, -1n));
              start = compare(gapEnd, end) < 0 ? gapEnd : end;
            }
            put(end);
          }
          if (!mappings.length) {
            result.complete = false;
            continue;
          }
          const actualRange: HlsPresentationRange = {
            start: mappings.reduce(
              (a, m) => (compare(a, m.presentation.start) < 0 ? a : m.presentation.start),
              mappings[0]!.presentation.start,
            ),
            end: mappings.reduce(
              (a, m) => (compare(a, m.presentation.end) > 0 ? a : m.presentation.end),
              mappings[0]!.presentation.end,
            ),
          };
          result.outputs.push({
            index: output.index,
            actualRange,
            reason: output.index === '0' ? 'Initial' : 'Unknown',
            tracks: output.tracks,
            bytesWritten: output.bytesWritten,
            mappings,
          });
        }
      } catch {
        result.complete = false;
      }
      return result;
    },
  };
}
