import type { HlsChapter, HlsMediaTime, HlsMultiTimelineOptions } from '@hls-downloader/shared';
import { z } from 'zod';

const mediaTime = z.object({
  ticks: z.string().regex(/^-?(0|[1-9]\d{0,38})$/),
  timescale: z.number().int().min(1).max(4294967295),
});
export const advancedTimelineSchema = z
  .object({
    epochAnchors: z
      .array(
        z.object({
          inputId: z.enum(['primary', 'audio']),
          epoch: z.string().regex(/^\d+$/),
          source: mediaTime,
          presentation: mediaTime,
        }),
      )
      .optional(),
    limits: z
      .object({
        samples: z.number().int().positive().optional(),
        resources: z.number().int().positive().optional(),
      })
      .optional(),
    tailDuration: mediaTime.optional(),
  })
  .strict();

/** Keep decimal input exact, including values beyond Number's integer precision. */
export function secondsToMediaTime(value: string): HlsMediaTime {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) throw new Error('时间须为非负秒数，最多 9 位小数');
  const fraction = match[2] ?? '';
  return { ticks: BigInt(match[1]! + fraction).toString(), timescale: 10 ** fraction.length };
}
export function parseRange(start: string, end: string) {
  const range = { start: secondsToMediaTime(start), end: secondsToMediaTime(end) };
  if (
    BigInt(range.start.ticks) * BigInt(range.end.timescale) >=
    BigInt(range.end.ticks) * BigInt(range.start.timescale)
  )
    throw new Error('结束时间必须大于开始时间');
  return range;
}
export function parseChapters(text: string): HlsChapter[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      const match = /^\s*(\d+(?:\.\d+)?)\s*-->\s*(\d+(?:\.\d+)?)\s*\|\s*(.+)$/.exec(line);
      if (!match) throw new Error(`第 ${index + 1} 行章节格式应为：开始秒数 --> 结束秒数 | 标题`);
      return { range: parseRange(match[1]!, match[2]!), title: match[3]!.trim() };
    });
}
export type TimelineFormInput = {
  timelineMode?: 'legacy' | 'timeline';
  rangeStart?: string;
  rangeEnd?: string;
  gapPolicy?: 'preserve' | 'collapse';
  changePolicy?: 'fail' | 'split';
  timelineAdvanced?: string;
  chaptersText?: string;
};
export function buildTimelineOptions(
  values: TimelineFormInput,
): HlsMultiTimelineOptions | undefined {
  if (values.timelineMode !== 'timeline') return undefined;
  const start = values.rangeStart?.trim() ?? '';
  const end = values.rangeEnd?.trim() ?? '';
  const advanced = values.timelineAdvanced?.trim();
  return {
    ...(start || end ? { range: parseRange(start, end) } : {}),
    gapPolicy: values.gapPolicy ?? 'preserve',
    changePolicy: values.changePolicy ?? 'fail',
    ...(advanced ? advancedTimelineSchema.parse(JSON.parse(advanced)) : {}),
  };
}
export function formatMediaTime(time: HlsMediaTime): string {
  const ticks = BigInt(time.ticks),
    scale = BigInt(time.timescale);
  const negative = ticks < BigInt(0),
    magnitude = negative ? -ticks : ticks;
  const milliseconds = (magnitude * BigInt(1000)) / scale;
  return `${negative ? '-' : ''}${milliseconds / BigInt(1000)}.${(milliseconds % BigInt(1000)).toString().padStart(3, '0')}s`;
}
export function outputFilename(base: string, index: string): string {
  const safe =
    Array.from(base, (character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[/\\<>:"|?*]/g, '_')
      .replace(/\.mp4$/i, '') || 'output';
  return `${safe}.${(BigInt(index) + BigInt(1)).toString().padStart(3, '0')}.mp4`;
}
