'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import HlsDownloader, { HlsDownloaderEvent } from '@hls-downloader/core';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';
import type { HlsDownloaderBrowserTranscodeOptions } from '@hls-downloader/adapters/browser';
import { HlsDownloaderErrorCode } from '@hls-downloader/shared';
import { toast } from 'sonner';

export type DownloadTaskStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'saved'
  | 'cancelled';

export type DownloadTask = {
  id: string;
  url: string;
  title: string;
  filename: string;
  previewSrc: string;
  percentage: number;
  status: DownloadTaskStatus;
  blobURL?: string;
  headers?: Record<string, string>;
  transcode?: HlsDownloaderBrowserTranscodeOptions;
};

type Action =
  | { type: 'add'; task: DownloadTask }
  | { type: 'update'; id: string; patch: Partial<DownloadTask> }
  | { type: 'remove'; id: string };

export function downloadTaskReducer(tasks: DownloadTask[], action: Action): DownloadTask[] {
  if (action.type === 'add') return [action.task, ...tasks];
  if (action.type === 'remove') return tasks.filter((task) => task.id !== action.id);
  return tasks.map((task) => (task.id === action.id ? { ...task, ...action.patch } : task));
}

export function selectQueuedTasks(
  tasks: DownloadTask[],
  activeCount: number,
  maxConcurrent: number,
): DownloadTask[] {
  const available = Math.max(0, maxConcurrent - activeCount);
  return tasks.filter((task) => task.status === 'queued').slice(0, available);
}

export function useDownloadManager(maxConcurrent = 3) {
  const [tasks, dispatch] = useReducer(downloadTaskReducer, []);
  const tasksRef = useRef(tasks);
  const controllers = useRef(new Map<string, AbortController>());
  const [downloader] = useState(
    () =>
      new HlsDownloader({
        adapter: BrowserAdapter,
        onEvent(event, payload) {
          const id = payload.operationId;
          if (event === HlsDownloaderEvent.STARTING_DOWNLOAD) {
            dispatch({ type: 'update', id, patch: { status: 'downloading', percentage: 1 } });
          } else if (event === HlsDownloaderEvent.DOWNLOADING_SEGMENTS) {
            const total = Math.max(1, payload.total ?? 1);
            const percentage = Math.floor(((payload.completed ?? 0) / total) * 80);
            dispatch({
              type: 'update',
              id,
              patch: { status: 'downloading', percentage: Math.min(80, Math.max(1, percentage)) },
            });
          } else if (event === HlsDownloaderEvent.STITCHING_SEGMENTS) {
            const total = Math.max(1, payload.total ?? 1);
            const percentage = 80 + Math.floor(((payload.completed ?? 0) / total) * 20);
            dispatch({
              type: 'update',
              id,
              patch: { status: 'downloading', percentage: Math.min(99, Math.max(80, percentage)) },
            });
          }
        },
      }),
  );

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    const queued = selectQueuedTasks(tasks, controllers.current.size, maxConcurrent);

    for (const task of queued) {
      const controller = new AbortController();
      controllers.current.set(task.id, controller);
      dispatch({ type: 'update', id: task.id, patch: { status: 'downloading' } });
      void downloader
        .download({
          url: task.url,
          filename: task.filename,
          headers: task.headers,
          transcode: task.transcode,
          operationId: task.id,
          signal: controller.signal,
        })
        .then((result) => {
          const previousUrl = tasksRef.current.find((item) => item.id === task.id)?.blobURL;
          if (previousUrl && previousUrl !== result.blobURL) URL.revokeObjectURL(previousUrl);
          dispatch({
            type: 'update',
            id: task.id,
            patch: { blobURL: result.blobURL, percentage: 100, status: 'completed' },
          });
          toast.success(`${task.title} 下载完成，请点击保存`);
        })
        .catch((error: unknown) => {
          const cancelled =
            controller.signal.aborted ||
            (error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === HlsDownloaderErrorCode.ABORTED);
          dispatch({
            type: 'update',
            id: task.id,
            patch: { status: cancelled ? 'cancelled' : 'failed' },
          });
          if (cancelled) toast.info(`${task.title} 已取消`);
          else toast.error(`${task.title} 下载失败`);
        })
        .finally(() => {
          controllers.current.delete(task.id);
          dispatch({ type: 'update', id: task.id, patch: {} });
        });
    }
  }, [downloader, maxConcurrent, tasks]);

  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      for (const task of tasksRef.current) {
        if (task.blobURL) URL.revokeObjectURL(task.blobURL);
      }
    },
    [],
  );

  const enqueue = useCallback(
    (task: Omit<DownloadTask, 'id' | 'percentage' | 'status' | 'blobURL'>): string => {
      const id = globalThis.crypto.randomUUID();
      dispatch({ type: 'add', task: { ...task, id, percentage: 0, status: 'queued' } });
      return id;
    },
    [],
  );

  const cancel = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    if (controller) controller.abort();
    else dispatch({ type: 'update', id, patch: { status: 'cancelled' } });
  }, []);

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    const task = tasksRef.current.find((item) => item.id === id);
    if (task?.blobURL) URL.revokeObjectURL(task.blobURL);
    dispatch({ type: 'remove', id });
  }, []);

  const save = useCallback(async (id: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task?.blobURL) return;
    const blobUrl = task.blobURL;
    try {
      const blob = await fetch(blobUrl).then((response) => response.blob());
      const showSaveFilePicker = (
        window as Window & {
          showSaveFilePicker?: (options?: {
            suggestedName?: string;
            types?: Array<{ description: string; accept: Record<string, string[]> }>;
          }) => Promise<{
            createWritable: () => Promise<{
              write: (data: Blob) => Promise<void>;
              close: () => Promise<void>;
            }>;
          }>;
        }
      ).showSaveFilePicker;

      if (showSaveFilePicker) {
        const isWebm = task.title.endsWith('.webm');
        const handle = await showSaveFilePicker({
          suggestedName: task.title,
          types: [
            isWebm
              ? { description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }
              : { description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        URL.revokeObjectURL(blobUrl);
      } else {
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = task.title;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      }

      dispatch({ type: 'update', id, patch: { blobURL: undefined, status: 'saved' } });
      toast.success(showSaveFilePicker ? '保存成功' : '已交给浏览器保存');
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
        return;
      toast.error('保存失败，请重试');
    }
  }, []);

  return { tasks, enqueue, cancel, remove, save };
}
