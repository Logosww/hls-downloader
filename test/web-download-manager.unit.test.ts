import { describe, expect, it } from 'vitest';
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
