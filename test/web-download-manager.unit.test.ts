import { describe, expect, it, vi } from 'vitest';

// State tests do not execute downloads or require built browser/WASM artifacts.
vi.mock('@hls-downloader/adapters/browser', () => ({ BrowserAdapter: vi.fn() }));
import {
  downloadTaskReducer,
  selectQueuedTasks,
  type DownloadTask,
} from '../packages/app/web/hooks/use-download-manager';

function task(id: string, status: DownloadTask['status'] = 'queued'): DownloadTask {
  return {
    id,
    status,
    url: `https://example.test/${id}.m3u8`,
    filename: id,
    title: `${id}.mp4`,
    previewSrc: '',
    percentage: 0,
  };
}

describe('web download manager state', () => {
  it('claims only the available queue slots', () => {
    const tasks = [task('one'), task('two'), task('done', 'completed'), task('three')];
    expect(selectQueuedTasks(tasks, 1, 3).map(({ id }) => id)).toEqual(['one', 'two']);
    expect(selectQueuedTasks(tasks, 3, 3)).toEqual([]);
  });

  it('updates and removes one operation without affecting others', () => {
    const initial = [task('one'), task('two')];
    const updated = downloadTaskReducer(initial, {
      type: 'update',
      id: 'one',
      patch: { status: 'cancelled', percentage: 20 },
    });
    expect(updated[0]).toMatchObject({ id: 'one', status: 'cancelled', percentage: 20 });
    expect(updated[1]).toBe(initial[1]);
    expect(downloadTaskReducer(updated, { type: 'remove', id: 'one' })).toEqual([initial[1]]);
  });
});

// Terminal task state must survive late progress from asynchronous output cleanup.
describe('file output task lifecycle', () => {
  it.each(['completed', 'saved', 'failed', 'cancelled'] as const)(
    'does not revive %s tasks',
    (status) => {
      const initial = [task('one', status)];
      expect(
        downloadTaskReducer(initial, {
          type: 'update',
          id: 'one',
          patch: { status: 'downloading', percentage: 50 },
        }),
      ).toEqual(initial);
    },
  );

  it('keeps saving active until close resolves', () => {
    const initial = [task('one', 'saving')];
    expect(selectQueuedTasks(initial, 1, 3)).toEqual([]);
    expect(
      downloadTaskReducer(initial, {
        type: 'update',
        id: 'one',
        patch: { status: 'saved', percentage: 100 },
      })[0],
    ).toMatchObject({ status: 'saved', percentage: 100 });
  });
});

import {
  buildTimelineOptions,
  secondsToMediaTime,
  parseChapters,
  outputFilename,
} from '../packages/app/web/lib/timeline-options';
describe('app timeline settings and artifacts', () => {
  it('keeps decimal and large inputs exact and refuses empty/reversed ranges', () => {
    expect(secondsToMediaTime('9007199254740993.001')).toEqual({
      ticks: '9007199254740993001',
      timescale: 1000,
    });
    expect(buildTimelineOptions({ timelineMode: 'legacy', rangeEnd: 'invalid' })).toBeUndefined();
    expect(
      buildTimelineOptions({
        timelineMode: 'timeline',
        rangeStart: '0.2',
        rangeEnd: '4.2',
        changePolicy: 'split',
      }),
    ).toMatchObject({
      range: { start: { ticks: '2', timescale: 10 }, end: { ticks: '42', timescale: 10 } },
      changePolicy: 'split',
    });
    expect(() =>
      buildTimelineOptions({ timelineMode: 'timeline', rangeStart: '2', rangeEnd: '' }),
    ).toThrow();
    expect(() =>
      buildTimelineOptions({ timelineMode: 'timeline', rangeStart: '2', rangeEnd: '2' }),
    ).toThrow();
    expect(() =>
      buildTimelineOptions({
        timelineMode: 'timeline',
        timelineAdvanced: '{"limits":{"samples":0}}',
      }),
    ).toThrow();
    expect(() =>
      buildTimelineOptions({
        timelineMode: 'timeline',
        timelineAdvanced: '{"changePolicy":"split"}',
      }),
    ).toThrow();
    expect(parseChapters('0.2 --> 3 | Part')).toMatchObject([
      { title: 'Part', range: { start: { ticks: '2', timescale: 10 } } },
    ]);
    expect(() => parseChapters('3 --> 2 | Bad')).toThrow();
    expect(outputFilename('../movie.mp4', '1')).toBe('.._movie.002.mp4');
  });
  it('preserves late completed outputs without reviving cancellation and saves each Blob independently', () => {
    const cancelled = [task('one', 'cancelled')];
    expect(
      downloadTaskReducer(cancelled, {
        type: 'artifacts',
        id: 'one',
        patch: { outputs: [{ index: '0', title: 'one.001.mp4', saved: true }] },
      })[0],
    ).toMatchObject({ status: 'cancelled', outputs: [{ saved: true }] });
    const outputs = [
      { index: '0', title: 'a.mp4', blobURL: 'blob:a', saved: false },
      { index: '1', title: 'b.mp4', blobURL: 'blob:b', saved: false },
    ];
    let state = [{ ...task('one', 'completed'), outputs }];
    state = downloadTaskReducer(state, {
      type: 'save-output',
      id: 'one',
      index: '0',
    }) as typeof state;
    expect(state[0]).toMatchObject({
      status: 'completed',
      outputs: [{ saved: true }, { saved: false, blobURL: 'blob:b' }],
    });
    state = downloadTaskReducer(state, {
      type: 'save-output',
      id: 'one',
      index: '1',
    }) as typeof state;
    expect(state[0]?.status).toBe('saved');
  });
});
