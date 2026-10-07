import { it, expect } from 'vitest';
import {
  buildMultiTrackConfig,
  availableTracks,
  renditionKey,
} from '../packages/app/web/lib/multitrack-options';
import { createMultiTrackMemoryOutput } from '../packages/app/web/lib/multitrack-output';
import type { Playlist, Rendition } from '@hls-downloader/shared';
const variant: Playlist = {
  name: 'default',
  uri: 'https://fixture/video.m3u8',
  bandwidth: 1,
  audioGroup: 'a',
  subtitlesGroup: 's',
};
const renditions: Rendition[] = [
  {
    type: 'audio',
    groupId: 'a',
    name: 'English',
    uri: 'https://fixture/en',
    language: 'en',
    default: true,
    autoselect: true,
  },
  {
    type: 'audio',
    groupId: 'a',
    name: 'Japanese',
    uri: 'https://fixture/ja',
    language: 'ja',
    default: true,
    autoselect: true,
  },
  {
    type: 'subtitles',
    groupId: 's',
    name: 'English',
    uri: 'https://fixture/sub',
    default: true,
    autoselect: true,
  },
  {
    type: 'audio',
    groupId: 'other',
    name: 'Other',
    uri: 'https://fixture/other',
    default: false,
    autoselect: true,
  },
];
const values = {
  trackMode: 'multi' as const,
  embeddedAudio: 'exclude' as const,
  audioTracks: renditions.slice(0, 2).map(renditionKey),
  embeddedSubtitles: [renditionKey(renditions[2]!)],
  defaultAudio: 'audio-1',
  subtitleBindings: { 'subtitle-2': 'audio-0' },
  memoryLimitMiB: '4',
};
it('selects only associated groups with stable IDs and one explicit default', () => {
  expect(availableTracks(variant, renditions).map((t) => t.id)).toEqual([
    'audio-0',
    'audio-1',
    'subtitle-2',
  ]);
  const config = buildMultiTrackConfig(values, variant, renditions)!;
  expect(config.maxBytes).toBe(4 * 1024 * 1024);
  expect(config.audioTracks?.map((t) => t.metadata?.default)).toEqual([false, true]);
  expect(config.subtitleTracks?.[0]).toMatchObject({
    id: 'subtitle-2',
    timelineInputId: 'audio-0',
    metadata: { default: false },
  });
  expect(buildMultiTrackConfig({ trackMode: 'single' })).toBeUndefined();
});
it('rejects stale variants, default tracks and subtitle bindings', () => {
  expect(() =>
    buildMultiTrackConfig(values, { ...variant, audioGroup: 'other' }, renditions),
  ).toThrow();
  expect(() =>
    buildMultiTrackConfig({ ...values, defaultAudio: 'primary' }, variant, renditions),
  ).toThrow();
  expect(() =>
    buildMultiTrackConfig(
      { ...values, subtitleBindings: { 'subtitle-2': 'missing' } },
      variant,
      renditions,
    ),
  ).toThrow();
});
it('validates exact ranges, arbitrary media anchors and recording budgets', () => {
  const config = buildMultiTrackConfig(
    {
      ...values,
      timelineMode: 'timeline',
      rangeStart: '9007199254740993.001',
      rangeEnd: '9007199254740994',
      timelineAdvanced:
        '{"anchors":[{"inputId":"audio-0","generation":"9007199254740993","epoch":"0","source":{"ticks":"0","timescale":1},"presentation":{"ticks":"0","timescale":1}}],"limits":{"samples":100}}',
    },
    variant,
    renditions,
  )!;
  expect(config.timeline?.range?.start.ticks).toBe('9007199254740993001');
  expect(config.timeline?.anchors?.[0].generation).toBe('9007199254740993');
  for (const advanced of [
    '{"epochAnchors":[]}',
    '{"limits":{"resources":1}}',
    '{"limits":{"samples":0}}',
  ])
    expect(() =>
      buildMultiTrackConfig({ ...values, timelineAdvanced: advanced }, variant, renditions),
    ).toThrow();
});
it.each(['0', '-1', '0.5', '4097', 'NaN'])('rejects invalid output budget %s', (memoryLimitMiB) => {
  expect(() => buildMultiTrackConfig({ ...values, memoryLimitMiB }, variant, renditions)).toThrow();
});
it('shares memory capacity across split outputs and preserves only closed Blobs', async () => {
  const output = createMultiTrackMemoryOutput('movie', 5);
  const first = (await output.acquire({ index: '0' })).getWriter();
  await first.write(new Uint8Array([1, 2, 3]));
  await first.close();
  const second = (await output.acquire({ index: '1' })).getWriter();
  await expect(second.write(new Uint8Array([4, 5, 6]))).rejects.toMatchObject({
    code: 'RESOURCE_LIMIT_EXCEEDED',
    reason: 'OutputCapacity',
  });
  expect(output.outputs).toHaveLength(1);
  expect(
    Array.from(new Uint8Array(await (await fetch(output.outputs[0]!.blobURL)).arrayBuffer())),
  ).toEqual([1, 2, 3]);
  output.revoke();
});
