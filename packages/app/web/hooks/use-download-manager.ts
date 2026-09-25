'use client';

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import HlsDownloader, { HlsDownloaderEvent } from '@hls-downloader/core';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';
import type { HlsDownloaderBrowserTranscodeOptions } from '@hls-downloader/adapters/browser';
import { HlsDownloaderErrorCode } from '@hls-downloader/shared';
import { toast } from 'sonner';
import {
  getSaveFilePicker,
  hasFilePicker,
  filePickerOptions,
  isUserAbort,
} from '../lib/file-output';

const subscribeToBrowser = () => () => {};
const serverHasFilePicker = () => false;

export type DownloadTaskStatus =
  | 'queued'
  | 'downloading'
  | 'saving'
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
  outputMode?: 'browser' | 'file';
  error?: string;
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
  return tasks.map((task) => {
    if (task.id !== action.id) return task;
    // Late SDK progress must not revive a cancelled/removed/finished operation.
    if (['saved', 'failed', 'cancelled'].includes(task.status)) return task;
    return { ...task, ...action.patch };
  });
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
  const fileHandles = useRef(new Map<string, FileSystemFileHandle>());
  const mounted = useRef(true);
  const browserHasFilePicker = useSyncExternalStore(
    subscribeToBrowser,
    hasFilePicker,
    serverHasFilePicker,
  );
  const [downloader] = useState(
    // The constructor only registers this callback; SDK events run after render.
    // react-doctor-disable-next-line react-hooks-js/refs
    () =>
      new HlsDownloader({
        adapter: BrowserAdapter,
        onEvent(event, payload) {
          const id = payload.operationId;
          if (!mounted.current || controllers.current.get(id)?.signal.aborted) return;
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
              patch: {
                status:
                  tasksRef.current.find((task) => task.id === id)?.outputMode === 'file'
                    ? 'saving'
                    : 'downloading',
                percentage: Math.min(99, Math.max(80, percentage)),
              },
            });
          }
        },
      }),
  );

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // Every async result below is guarded by mounted/abort state and the task reducer.
  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect
  useEffect(() => {
    const queued = selectQueuedTasks(
      tasks.filter((task) => !controllers.current.has(task.id)),
      controllers.current.size,
      maxConcurrent,
    );

    for (const task of queued) {
      const controller = new AbortController();
      controllers.current.set(task.id, controller);
      dispatch({ type: 'update', id: task.id, patch: { status: 'downloading' } });
      const options = {
        url: task.url,
        filename: task.filename,
        headers: task.headers,
        operationId: task.id,
        signal: controller.signal,
      };
      void (async () => {
        if (task.outputMode === 'file') {
          const handle = fileHandles.current.get(task.id);
          if (!handle) throw new Error('保存位置已失效，请重新创建任务');
          const writable = await handle.createWritable();
          if (controller.signal.aborted) {
            await writable.abort().catch(() => {});
            throw new DOMException('Operation aborted', 'AbortError');
          }
          await downloader.downloadToWritable(options, writable);
          if (!mounted.current || controller.signal.aborted) return;
          dispatch({ type: 'update', id: task.id, patch: { percentage: 100, status: 'saved' } });
          toast.success(`${task.title} 已保存`);
        } else {
          const result = await downloader.download({ ...options, transcode: task.transcode });
          if (
            !mounted.current ||
            controller.signal.aborted ||
            !tasksRef.current.some((item) => item.id === task.id)
          ) {
            URL.revokeObjectURL(result.blobURL);
            return;
          }
          dispatch({
            type: 'update',
            id: task.id,
            patch: { blobURL: result.blobURL, percentage: 100, status: 'completed' },
          });
          toast.success(`${task.title} 下载完成，请点击保存`);
        }
      })()
        .catch((error: unknown) => {
          if (!mounted.current) return;
          const cancelled = controller.signal.aborted || isUserAbort(error);
          const outputFailure =
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === HlsDownloaderErrorCode.OUTPUT_WRITE_FAILED;
          const message =
            task.outputMode === 'file'
              ? outputFailure
                ? '文件写入失败，请检查磁盘空间与写入权限后重试'
                : '下载或文件写入失败，请重新选择保存位置后重试'
              : '下载失败，请重试';
          dispatch({
            type: 'update',
            id: task.id,
            patch: {
              status: cancelled ? 'cancelled' : 'failed',
              error: cancelled ? undefined : message,
            },
          });
          if (cancelled) toast.info(`${task.title} 已取消`);
          else toast.error(`${task.title}：${message}`);
        })
        .finally(() => {
          controllers.current.delete(task.id);
          fileHandles.current.delete(task.id);
          if (mounted.current) dispatch({ type: 'update', id: task.id, patch: {} });
        });
    }
  }, [downloader, maxConcurrent, tasks]);

  useEffect(() => {
    mounted.current = true;
    const active = controllers.current;
    const handles = fileHandles.current;
    return () => {
      mounted.current = false;
      for (const controller of active.values()) controller.abort();
      handles.clear();
      for (const task of tasksRef.current) {
        if (task.blobURL) URL.revokeObjectURL(task.blobURL);
      }
    };
  }, []);

  const enqueue = useCallback(
    (task: Omit<DownloadTask, 'id' | 'percentage' | 'status' | 'blobURL'>): string => {
      const id = globalThis.crypto.randomUUID();
      dispatch({ type: 'add', task: { ...task, id, percentage: 0, status: 'queued' } });
      return id;
    },
    [],
  );

  const enqueueToFile = useCallback(
    async (
      task: Omit<DownloadTask, 'id' | 'percentage' | 'status' | 'blobURL' | 'outputMode'>,
    ): Promise<boolean> => {
      const picker = getSaveFilePicker();
      if (!picker || !downloader.capabilities.writableOutput || task.transcode) {
        toast.error('当前设置不支持大文件直存，请选择普通下载');
        return false;
      }
      try {
        // Must be the first asynchronous action in the user click handler.
        const handle = await picker(filePickerOptions(task.title));
        if (!mounted.current) return false;
        for (const existing of fileHandles.current.values()) {
          if (await handle.isSameEntry(existing)) {
            toast.error('已有任务使用此文件，请选择其他保存位置');
            return false;
          }
        }
        if (!mounted.current) return false;
        const id = globalThis.crypto.randomUUID();
        fileHandles.current.set(id, handle);
        dispatch({
          type: 'add',
          task: {
            ...task,
            id,
            title: handle.name,
            outputMode: 'file',
            percentage: 0,
            status: 'queued',
          },
        });
        return true;
      } catch (error) {
        if (!isUserAbort(error)) toast.error('无法选择保存位置，请检查浏览器的文件访问权限');
        return false;
      }
    },
    [downloader],
  );

  const cancel = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    if (controller) controller.abort();
    else {
      fileHandles.current.delete(id);
      dispatch({ type: 'update', id, patch: { status: 'cancelled' } });
    }
  }, []);

  const remove = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    controller?.abort();
    // Keep active file reservations until asynchronous writer cleanup finishes.
    if (!controller) fileHandles.current.delete(id);
    const task = tasksRef.current.find((item) => item.id === id);
    if (task?.blobURL) URL.revokeObjectURL(task.blobURL);
    dispatch({ type: 'remove', id });
  }, []);

  const save = useCallback(async (id: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task?.blobURL) return;
    const blobUrl = task.blobURL;
    try {
      const showSaveFilePicker = getSaveFilePicker();
      if (showSaveFilePicker) {
        const handle = await showSaveFilePicker(filePickerOptions(task.title));
        const blob = await fetch(blobUrl).then((response) => response.blob());
        const writable = await handle.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          if (!isUserAbort(error)) toast.error('保存失败，请重试');
          return;
        }
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

  return {
    tasks,
    enqueue,
    enqueueToFile,
    canWriteToFile: browserHasFilePicker && downloader.capabilities.writableOutput === true,
    cancel,
    remove,
    save,
  };
}
