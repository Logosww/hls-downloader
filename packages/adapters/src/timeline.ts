import {
  HlsDownloaderError,
  HlsDownloaderErrorCode as Code,
  type HlsTimelineOptions,
  type HlsMultiTimelineOptions,
  type HlsMediaTime,
} from '@hls-downloader/shared';
export const timelineProfile = Object.freeze({
  finite: true,
  ranges: true,
  epochs: true,
  split: true,
  resume: false,
} as const);
/** Normalize the upstream diagnostic wire once, without converting protocol integers. */
export function camelCaseReport(value: any): any {
  if (Array.isArray(value)) return value.map(camelCaseReport);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        camelCaseReport(v),
      ]),
    );
  return value;
}
export function validateTimeline(
  value: HlsTimelineOptions | HlsMultiTimelineOptions,
  multiple: boolean,
): void {
  const bad = (code: Code, reason: string): never => {
    throw new HlsDownloaderError(code, 'Invalid timeline options', { reason });
  };
  const time = (t: HlsMediaTime) => {
    if (
      !t ||
      typeof t.ticks !== 'string' ||
      !/^(0|-[1-9]\d*|[1-9]\d*)$/.test(t.ticks) ||
      !Number.isInteger(t.timescale) ||
      t.timescale <= 0 ||
      t.timescale > 0xffffffff
    )
      bad(Code.RANGE_INVALID, 'InvalidTime');
    const ticks = BigInt(t.ticks);
    if (ticks < -(1n << 127n) || ticks >= 1n << 127n) bad(Code.RANGE_INVALID, 'TimeOverflow');
  };
  if (!value || typeof value !== 'object') bad(Code.TIMELINE_FAILED, 'InvalidOptions');
  if (value.range) {
    time(value.range.start);
    time(value.range.end);
    if (
      BigInt(value.range.start.ticks) < 0n ||
      BigInt(value.range.start.ticks) * BigInt(value.range.end.timescale) >=
        BigInt(value.range.end.ticks) * BigInt(value.range.start.timescale)
    )
      bad(Code.RANGE_INVALID, 'InvalidRange');
  }
  if (value.gapPolicy !== undefined && !['preserve', 'collapse'].includes(value.gapPolicy))
    bad(Code.TIMELINE_FAILED, 'InvalidGapPolicy');
  if (
    'changePolicy' in value &&
    value.changePolicy !== undefined &&
    (!multiple || !['fail', 'split'].includes(value.changePolicy))
  )
    bad(Code.UNSUPPORTED_OUTPUT, 'SplitRequiresProvider');
  for (const a of value.epochAnchors ?? []) {
    time(a.source);
    time(a.presentation);
    if (
      !['primary', 'audio'].includes(a.inputId) ||
      !/^(0|[1-9]\d*)$/.test(a.epoch) ||
      BigInt(a.epoch) >= 1n << 64n
    )
      bad(Code.TIMELINE_FAILED, 'InvalidAnchor');
  }
  if (value.tailDuration) {
    time(value.tailDuration);
    if (BigInt(value.tailDuration.ticks) <= 0n) bad(Code.TIMELINE_FAILED, 'InvalidTailDuration');
  }
  for (const n of Object.values(value.limits ?? {}))
    if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0))
      bad(Code.RESOURCE_LIMIT_EXCEEDED, 'InvalidPlanningLimits');
}
