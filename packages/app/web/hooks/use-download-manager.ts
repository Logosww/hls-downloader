'use client';

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import HlsDownloader, { HlsDownloaderEvent } from '@hls-downloader/core';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';
import type { HlsDownloaderBrowserTranscodeOptions } from '@hls-downloader/adapters/browser';
import type {
  VariantSelectOptions,
  HlsMultiTimelineOptions,
  HlsTimelineReport,
  HlsChapter,
  HlsSidecar,
  HlsCompletedOutput,
  HlsMultiTrackReport,
} from '@hls-downloader/shared';
import { HlsDownloaderErrorCode, exportChapters } from '@hls-downloader/shared';
import { toast } from 'sonner';
import {
  getSaveFilePicker,
  hasFilePicker,
  filePickerOptions,
  isUserAbort,
  getDirectoryPicker,
  hasDirectoryPicker,
} from '../lib/file-output';

import { createTimelineFileOutput } from '../lib/timeline-output';
import type { WebMultiTrackConfig } from '../lib/multitrack-options';
import { createMultiTrackMemoryOutput } from '../lib/multitrack-output';
import { outputFilename } from '../lib/timeline-options';

export type TaskOutput = { index: string; title: string; blobURL?: string; saved: boolean };

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
  variant?: VariantSelectOptions;
  transcode?: HlsDownloaderBrowserTranscodeOptions;
  multiTrack?: WebMultiTrackConfig;
  multiTrackReport?: HlsMultiTrackReport;
  multiTrackBytes?: string;
  timeline?: HlsMultiTimelineOptions;
  timelineReport?: HlsTimelineReport;
  outputs?: TaskOutput[];
  subtitle?: { groupId: string; name: string };
  chapters?: HlsChapter[];
  sidecars?: HlsSidecar[];
  sidecarError?: string;
};

type Action =
  | { type: 'add'; task: DownloadTask }
  | { type: 'update'; id: string; patch: Partial<DownloadTask> }
  | { type: 'remove'; id: string }
  | { type: 'save-output'; id: string; index: string }
  | {
      type: 'artifacts';
      id: string;
      patch: Pick<
        Partial<DownloadTask>,
        'outputs' | 'sidecars' | 'sidecarError' | 'timelineReport' | 'multiTrackReport'
      >;
    };

export function downloadTaskReducer(tasks: DownloadTask[], action: Action): DownloadTask[] {
  if (action.type === 'add') return [action.task, ...tasks];
  if (action.type === 'remove') return tasks.filter((task) => task.id !== action.id);
  return tasks.map((task) => {
    if (task.id !== action.id) return task;
    if (action.type === 'save-output') {
      const outputs = task.outputs?.map((output) =>
        output.index === action.index ? { ...output, saved: true, blobURL: undefined } : output,
      );
      return {
        ...task,
        outputs,
        status:
          task.status === 'completed' && outputs?.every((output) => output.saved)
            ? 'saved'
            : task.status,
      };
    }
    // Late library progress must not revive a cancelled/removed/finished operation.
    if (action.type === 'update' && task.status === 'completed' && action.patch.status !== 'saved')
      return task;
    if (action.type !== 'artifacts' && ['saved', 'failed', 'cancelled'].includes(task.status))
      return task;
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
  const directories = useRef(new Map<string, FileSystemDirectoryHandle>());
  const mounted = useRef(true);
  const browserHasFilePicker = useSyncExternalStore(
    subscribeToBrowser,
    hasFilePicker,
    serverHasFilePicker,
  );
  const browserHasDirectoryPicker = useSyncExternalStore(
    subscribeToBrowser,
    hasDirectoryPicker,
    serverHasFilePicker,
  );
  const [downloader] = useState(
    // The constructor only registers this callback; library events run after render.
    // react-doctor-disable-next-line react-hooks-js/refs
    () =>
      new HlsDownloader({
        adapter: BrowserAdapter,
        onEvent(event, payload) {
          const id = payload.operationId;
          if (
            !mounted.current ||
            !controllers.current.has(id) ||
            controllers.current.get(id)?.signal.aborted
          )
            return;
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
        variant: task.variant,
        timeline: task.timeline,
        operationId: task.id,
        signal: controller.signal,
      };
      const fileOutput = createTimelineFileOutput({
        filename: task.filename,
        signal: controller.signal,
        directory: directories.current.get(task.id),
        fileHandle: fileHandles.current.get(task.id),
        reservedHandles: () =>
          [...fileHandles.current.entries()]
            .filter(([id]) => id !== task.id)
            .map(([, handle]) => handle),
      });
      const memoryOutput = task.multiTrack
        ? createMultiTrackMemoryOutput(task.filename, task.multiTrack.maxBytes)
        : undefined;
      void (async () => {
        let report: HlsTimelineReport | undefined;
        if (task.multiTrack) {
          const { maxBytes, ...config } = task.multiTrack;
          const split = config.timeline?.changePolicy === 'split';
          const result = await downloader.downloadMultiTrack({
            ...options,
            ...config,
            output:
              task.outputMode === 'file'
                ? { type: 'writables', acquire: fileOutput.factory }
                : split
                  ? { type: 'writables', acquire: memoryOutput!.acquire }
                  : { type: 'blob', maxBytes },
            onEvent(event) {
              if (
                !mounted.current ||
                controller.signal.aborted ||
                !controllers.current.has(task.id)
              )
                return;
              if (event.type === 'progress')
                dispatch({
                  type: 'update',
                  id: task.id,
                  patch: { multiTrackBytes: event.bytesWritten },
                });
              if (event.type === 'state' && ['running', 'finalizing'].includes(event.state))
                dispatch({
                  type: 'update',
                  id: task.id,
                  patch: { status: event.state === 'finalizing' ? 'saving' : 'downloading' },
                });
            },
          });
          if ('blob' in result && result.blob instanceof Blob)
            memoryOutput!.outputs.push({
              index: '0',
              title: task.title,
              blobURL: URL.createObjectURL(result.blob),
              saved: false,
            });
          fileOutput.complete(result.report.outputs);
          if (
            !mounted.current ||
            controller.signal.aborted ||
            !tasksRef.current.some((item) => item.id === task.id)
          ) {
            memoryOutput!.revoke();
            return;
          }
          const directory = directories.current.get(task.id),
            handle = fileHandles.current.get(task.id);
          dispatch({
            type: 'update',
            id: task.id,
            patch: {
              status: task.outputMode === 'file' ? 'saved' : 'completed',
              percentage: 100,
              multiTrackReport: result.report,
              outputs:
                task.outputMode === 'file'
                  ? result.report.outputs.map(({ index }) => ({
                      index,
                      title: directory ? outputFilename(task.filename, index) : handle!.name,
                      saved: true,
                    }))
                  : [...memoryOutput!.outputs],
            },
          });
        } else if (task.timeline) {
          if (task.outputMode === 'file') {
            const handle = fileHandles.current.get(task.id);
            const directory = directories.current.get(task.id);
            const result = await downloader.downloadToWritables(options, fileOutput.factory);
            report = result.timelineReport;
            fileOutput.complete(report.outputs);
            if (!mounted.current || controller.signal.aborted) return;
            dispatch({
              type: 'update',
              id: task.id,
              patch: {
                status: 'saved',
                percentage: 100,
                timelineReport: report,
                outputs: report.outputs.map(({ index }) => ({
                  index,
                  title: directory ? outputFilename(task.filename, index) : handle!.name,
                  saved: true,
                })),
              },
            });
          } else {
            const result = await downloader.downloadOutputs(options);
            if (
              !mounted.current ||
              controller.signal.aborted ||
              !tasksRef.current.some((item) => item.id === task.id)
            ) {
              for (const output of result.outputs) URL.revokeObjectURL(output.blobURL);
              return;
            }
            report = result.timelineReport;
            dispatch({
              type: 'update',
              id: task.id,
              patch: {
                status: 'completed',
                percentage: 100,
                timelineReport: report,
                outputs: result.outputs.map((output) => ({
                  index: output.index,
                  title: outputFilename(task.filename, output.index),
                  blobURL: output.blobURL,
                  saved: false,
                })),
              },
            });
          }
        } else if (task.outputMode === 'file') {
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
        }
        toast.success(
          task.outputMode === 'file'
            ? `${task.title} 已保存`
            : `${task.title} 下载完成，请点击保存`,
        );
        if (report) {
          const sidecars: HlsSidecar[] = [];
          const failures: string[] = [];
          if (task.chapters?.length) {
            try {
              sidecars.push(
                ...exportChapters({
                  timelineReport: report,
                  chapters: task.chapters,
                  filename: `${task.filename}.chapters`,
                }),
              );
            } catch {
              failures.push('章节导出失败');
            }
          }
          if (task.subtitle) {
            try {
              const result = await downloader.downloadSubtitleOutputs({
                ...options,
                operationId: `${task.id}:subtitles`,
                timelineReport: report,
                subtitle: task.subtitle,
                filename: `${task.filename}.subtitles`,
              });
              sidecars.push(...result.outputs);
            } catch {
              if (!controller.signal.aborted)
                failures.push('字幕导出失败：无法确认同步或资源不可用');
            }
          }
          if (mounted.current && !controller.signal.aborted)
            dispatch({
              type: 'artifacts',
              id: task.id,
              patch: { sidecars, sidecarError: failures.join('；') || undefined },
            });
        }
      })()
        .catch((error: unknown) => {
          if (task.multiTrack) {
            const completed =
              error &&
              typeof error === 'object' &&
              'completedMultiTrackOutputs' in error &&
              Array.isArray(error.completedMultiTrackOutputs)
                ? (error.completedMultiTrackOutputs as { index: string }[])
                : [];
            fileOutput.complete(completed);
            const directory = directories.current.get(task.id),
              handle = fileHandles.current.get(task.id);
            if (mounted.current && tasksRef.current.some((item) => item.id === task.id))
              dispatch({
                type: 'artifacts',
                id: task.id,
                patch: {
                  outputs:
                    task.outputMode === 'file'
                      ? completed.map(({ index }) => ({
                          index,
                          title: directory
                            ? outputFilename(task.filename, index)
                            : (handle?.name ?? task.title),
                          saved: true,
                        }))
                      : [...memoryOutput!.outputs],
                },
              });
            else memoryOutput!.revoke();
          }
          if (
            task.outputMode === 'file' &&
            error &&
            typeof error === 'object' &&
            'completedOutputs' in error &&
            Array.isArray(error.completedOutputs)
          ) {
            const completed = error.completedOutputs as HlsCompletedOutput[];
            fileOutput.complete(completed);
            const directory = directories.current.get(task.id);
            const handle = fileHandles.current.get(task.id);
            if (mounted.current)
              dispatch({
                type: 'artifacts',
                id: task.id,
                patch: {
                  outputs: completed.map(({ index }) => ({
                    index,
                    title: directory
                      ? outputFilename(task.filename, index)
                      : (handle?.name ?? task.title),
                    saved: true,
                  })),
                },
              });
          }
          if (!mounted.current) return;
          const cancelled = controller.signal.aborted || isUserAbort(error);
          const outputFailure =
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === HlsDownloaderErrorCode.OUTPUT_WRITE_FAILED;
          const code =
            error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          const reason =
            error && typeof error === 'object' && 'reason' in error ? error.reason : undefined;
          const timelineMessage =
            task.multiTrack && reason === 'UnsupportedSubtitleProfile'
              ? '内嵌字幕仅支持纯文本及有限 cue 设置，不支持样式、区域或 markup'
              : task.multiTrack && code === 'UNSUPPORTED_RENDITION'
                ? '多轨下载要求所有所选播放列表均已结束，且选轨属于当前视频质量'
                : task.multiTrack && code === 'SUBTITLE_INVALID'
                  ? '内嵌字幕格式或时钟映射无效，请检查字幕绑定及时间锚点'
                  : task.multiTrack && code === 'MULTITRACK_FAILED'
                    ? '多轨处理失败，请检查媒体时钟、编码与配置变化策略'
                    : task.multiTrack && code === 'RESOURCE_LIMIT_EXCEEDED'
                      ? '多轨任务超出内存或处理预算；可提高上限、缩小范围或使用文件直存'
                      : code === 'RANGE_INVALID'
                        ? '范围无效或超出媒体时间轴'
                        : code === 'RESOURCE_LIMIT_EXCEEDED'
                          ? '时间轴规划超出预算，请缩小范围或调整高级设置'
                          : code === 'RESOURCE_CHANGED'
                            ? '媒体资源已变化，请重新创建任务'
                            : code === 'TIMELINE_FAILED'
                              ? '时间轴无法映射或单文件无法表达变化，请检查锚点、缺口或拆分设置'
                              : code === 'UNSUPPORTED_ENCRYPTION'
                                ? '此加密容器与编码组合暂不支持'
                                : code === 'KEY_UNAVAILABLE' ||
                                    code === 'KEY_INVALID' ||
                                    code === 'KEY_RESOLUTION_FAILED'
                                  ? '无法获取有效密钥，请检查资源与请求头'
                                  : undefined;
          const message =
            timelineMessage ??
            (task.outputMode === 'file'
              ? outputFailure
                ? '文件写入失败，请检查磁盘空间与写入权限后重试'
                : '下载或文件写入失败，请重新选择保存位置后重试'
              : '下载失败，请重试');
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
        .finally(async () => {
          await fileOutput.cleanup();
          controllers.current.delete(task.id);
          fileHandles.current.delete(task.id);
          directories.current.delete(task.id);
          if (mounted.current) dispatch({ type: 'update', id: task.id, patch: {} });
        });
    }
  }, [downloader, maxConcurrent, tasks]);

  useEffect(() => {
    mounted.current = true;
    const active = controllers.current;
    const handles = fileHandles.current;
    const directoryHandles = directories.current;
    return () => {
      mounted.current = false;
      for (const controller of active.values()) controller.abort();
      handles.clear();
      directoryHandles.clear();
      for (const task of tasksRef.current) {
        if (task.blobURL) URL.revokeObjectURL(task.blobURL);
        for (const output of task.outputs ?? [])
          if (output.blobURL) URL.revokeObjectURL(output.blobURL);
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
      const split = (task.multiTrack?.timeline ?? task.timeline)?.changePolicy === 'split';
      const picker = split ? getDirectoryPicker() : getSaveFilePicker();
      if (!picker || !downloader.capabilities.writableOutput || task.transcode) {
        toast.error('当前设置不支持大文件直存，请选择普通下载');
        return false;
      }
      try {
        // Must be the first asynchronous action in the user click handler.
        const handle = split
          ? await getDirectoryPicker()!({ mode: 'readwrite' })
          : await getSaveFilePicker()!(filePickerOptions(task.title));
        if (!mounted.current) return false;
        for (const existing of [...fileHandles.current.values(), ...directories.current.values()]) {
          if (await handle.isSameEntry(existing)) {
            toast.error('已有任务使用此文件，请选择其他保存位置');
            return false;
          }
        }
        if (!mounted.current) return false;
        const id = globalThis.crypto.randomUUID();
        if (split) directories.current.set(id, handle as FileSystemDirectoryHandle);
        else fileHandles.current.set(id, handle as FileSystemFileHandle);
        dispatch({
          type: 'add',
          task: {
            ...task,
            id,
            title: split ? task.title : handle.name,
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
      directories.current.delete(id);
      dispatch({ type: 'update', id, patch: { status: 'cancelled' } });
    }
  }, []);

  const remove = useCallback((id: string) => {
    const controller = controllers.current.get(id);
    controller?.abort();
    // Keep active file reservations until asynchronous writer cleanup finishes.
    if (!controller) {
      fileHandles.current.delete(id);
      directories.current.delete(id);
    }
    const task = tasksRef.current.find((item) => item.id === id);
    if (task?.blobURL) URL.revokeObjectURL(task.blobURL);
    for (const output of task?.outputs ?? [])
      if (output.blobURL) URL.revokeObjectURL(output.blobURL);
    dispatch({ type: 'remove', id });
  }, []);

  const save = useCallback(async (id: string, index?: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    const output = task?.outputs?.find((item) => item.index === index);
    const blobUrl = output?.blobURL ?? (index === undefined ? task?.blobURL : undefined);
    if (!task || !blobUrl) return;
    const title = output?.title ?? task.title;
    try {
      const showSaveFilePicker = getSaveFilePicker();
      if (showSaveFilePicker) {
        const handle = await showSaveFilePicker(filePickerOptions(title));
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
        anchor.download = title;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
      }

      if (output) {
        dispatch({ type: 'save-output', id, index: output.index });
      } else dispatch({ type: 'update', id, patch: { blobURL: undefined, status: 'saved' } });
      toast.success(showSaveFilePicker ? '保存成功' : '已交给浏览器保存');
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
        return;
      toast.error('保存失败，请重试');
    }
  }, []);

  const saveArtifact = useCallback((id: string, filename?: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task) return;
    const sidecar = task.sidecars?.find((item) => item.filename === filename);
    const text =
      sidecar?.text ??
      (filename === undefined && (task.multiTrackReport || task.timelineReport)
        ? JSON.stringify(task.multiTrackReport ?? task.timelineReport, null, 2)
        : undefined);
    if (text === undefined) return;
    const url = URL.createObjectURL(
      new Blob([text], { type: sidecar?.mimeType ?? 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download =
      sidecar?.filename ?? `${task.filename}.${task.multiTrack ? 'multitrack' : 'timeline'}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  return {
    tasks,
    enqueue,
    enqueueToFile,
    canWriteToFile: browserHasFilePicker && downloader.capabilities.writableOutput === true,
    canWriteToDirectory: browserHasDirectoryPicker,
    saveArtifact,
    cancel,
    remove,
    save,
  };
}
