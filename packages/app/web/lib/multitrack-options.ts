import type { HlsMultiTrackOptions, Playlist, Rendition } from '@hls-downloader/shared';
import { z } from 'zod';
import { parseRange } from './timeline-options';

const time = z.object({
  ticks: z.string().regex(/^-?(0|[1-9]\d{0,38})$/),
  timescale: z.number().int().min(1).max(4294967295),
});
const integer = z.string().regex(/^(0|[1-9]\d*)$/);
const positive = z.number().int().positive();
export const multiTrackAdvancedSchema = z
  .object({
    anchors: z
      .array(
        z
          .object({
            inputId: z.string().min(1),
            generation: integer,
            epoch: integer,
            source: time,
            presentation: time,
          })
          .strict(),
      )
      .optional(),
    tailDuration: time.optional(),
    limits: z
      .object({
        queuedDescriptors: positive.optional(),
        queuedMetadataBytes: positive.optional(),
        historyEntries: positive.optional(),
        samples: positive.optional(),
        sampleBytes: positive.optional(),
        probeSegments: positive.optional(),
        maxSkew: time.optional(),
        inputTimeoutMs: positive.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MultiTrackFormInput = {
  trackMode?: 'single' | 'multi';
  embeddedAudio?: 'keep' | 'exclude';
  audioTracks?: string[];
  embeddedSubtitles?: string[];
  defaultAudio?: string;
  defaultSubtitle?: string;
  subtitleBindings?: Record<string, string>;
  memoryLimitMiB?: string;
  timelineMode?: 'legacy' | 'timeline';
  rangeStart?: string;
  rangeEnd?: string;
  gapPolicy?: 'preserve' | 'collapse';
  changePolicy?: 'fail' | 'split';
  timelineAdvanced?: string;
};
export type WebMultiTrackConfig = Pick<
  HlsMultiTrackOptions,
  'embeddedAudio' | 'primaryAudio' | 'audioTracks' | 'subtitleTracks' | 'timeline' | 'limits'
> & { maxBytes: number };
export function renditionKey(r: Rendition): string {
  return JSON.stringify([r.groupId, r.name]);
}
export function availableTracks(variant?: Playlist, renditions: Rendition[] = []) {
  return renditions
    .map((rendition, index) => ({
      rendition,
      id: `${rendition.type === 'audio' ? 'audio' : 'subtitle'}-${index}`,
      value: renditionKey(rendition),
    }))
    .filter(
      ({ rendition: r }) =>
        r.uri &&
        ((r.type === 'audio' && r.groupId === variant?.audioGroup) ||
          (r.type === 'subtitles' && r.groupId === variant?.subtitlesGroup)),
    );
}
export function buildMultiTrackConfig(
  values: MultiTrackFormInput,
  variant?: Playlist,
  renditions?: Rendition[],
): WebMultiTrackConfig | undefined {
  if (values.trackMode !== 'multi') return undefined;
  const available = availableTracks(variant, renditions);
  const selected = (keys: string[], type: Rendition['type']) =>
    keys.map((key) => {
      const item = available.find((t) => t.value === key && t.rendition.type === type);
      if (!item) throw new Error('所选轨道不属于当前视频质量，请重新选择');
      return item;
    });
  const audio = selected(values.audioTracks ?? [], 'audio'),
    subtitles = selected(values.embeddedSubtitles ?? [], 'subtitles');
  if (audio.length > 31 || subtitles.length > 32)
    throw new Error('最多选择 31 条外部音轨和 32 条字幕');
  const mediaIds = new Set(['primary', ...audio.map((t) => t.id)]);
  const memory = Number(values.memoryLimitMiB ?? '512');
  if (!Number.isInteger(memory) || memory < 1 || memory > 4096)
    throw new Error('内存上限须为 1–4096 MiB');
  const advanced = values.timelineAdvanced?.trim();
  const parsed = advanced ? multiTrackAdvancedSchema.parse(JSON.parse(advanced)) : {};
  if (parsed.anchors?.some((a) => !mediaIds.has(a.inputId)))
    throw new Error('时间锚点引用了未选择的媒体输入');
  const defaultAudio = values.defaultAudio ?? 'auto',
    defaultSubtitle = values.defaultSubtitle ?? 'none';
  if (
    defaultAudio !== 'auto' &&
    !(defaultAudio === 'primary' && values.embeddedAudio !== 'exclude') &&
    !audio.some((t) => t.id === defaultAudio)
  )
    throw new Error('默认音轨未被选入');
  if (defaultSubtitle !== 'none' && !subtitles.some((t) => t.id === defaultSubtitle))
    throw new Error('默认字幕未被选入');
  const start = values.rangeStart?.trim() ?? '',
    end = values.rangeEnd?.trim() ?? '';
  return {
    embeddedAudio: values.embeddedAudio ?? 'keep',
    primaryAudio: { default: defaultAudio === 'primary' },
    audioTracks: audio.map((t) => ({
      id: t.id,
      selector: { groupId: t.rendition.groupId, name: t.rendition.name },
      metadata: { default: defaultAudio === t.id },
    })),
    subtitleTracks: subtitles.map((t) => {
      const timelineInputId = values.subtitleBindings?.[t.id] ?? 'primary';
      if (!mediaIds.has(timelineInputId)) throw new Error('字幕时钟绑定引用了未选择的媒体输入');
      return {
        id: t.id,
        selector: { groupId: t.rendition.groupId, name: t.rendition.name },
        timelineInputId,
        metadata: { default: defaultSubtitle === t.id },
      };
    }),
    timeline: {
      ...(values.timelineMode === 'timeline' && (start || end)
        ? { range: parseRange(start, end) }
        : {}),
      gapPolicy: values.gapPolicy ?? 'preserve',
      changePolicy: values.changePolicy ?? 'fail',
      anchors: parsed.anchors,
      tailDuration: parsed.tailDuration,
    },
    limits: parsed.limits,
    maxBytes: memory * 1024 * 1024,
  };
}
