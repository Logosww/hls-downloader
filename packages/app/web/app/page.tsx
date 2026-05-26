'use client';

import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { DownloadIcon, Loader2Icon } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import z from 'zod';
import { useEffect, useRef, useState } from 'react';
import ConfirmModal, { IConfirmModalProps } from '@/components/confirm-modal';
import { Platform, usePlatform } from '@/hooks';
import { ModeToggle } from '@/components/mode-toggle';
import HlsDownloader, { HlsDownloaderEvent } from '@hls-downloader/core';
import { BrowserAdapter } from '@hls-downloader/adapters/browser';
import DownloadList, { IDownloadListItem } from '@/components/download-list';
import { toast } from 'sonner';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { HeadersModal } from '@/components/headers-modal';
import { useSearchParams } from 'next/navigation';

export const dynamic = 'force-static';

const formSchema = z.object({
  url: z
    .url('请输入 HLS 链接')
    .refine((url) => URL.canParse(url) && new URL(url).pathname.endsWith('.m3u8'), {
      message: '无效的 HLS 链接',
    }),
});

export default function HomePage() {
  const platform = usePlatform();
  const searchParams = useSearchParams();
  const [downloadList, setDownloadList] = useState<IDownloadListItem[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [headersModalOpen, setHeadersModalOpen] = useState(false);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [metadata, setMetadata] = useState<IConfirmModalProps['metadata']>();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { url: searchParams.get('url') ?? '' },
  });

  const downloader = useRef<HlsDownloader<typeof BrowserAdapter>>(void 0);
  const currentDownloadId = useRef<string>(void 0);

  const updateDownloadTask = (id: string, payload: Partial<IDownloadListItem>) => {
    setDownloadList((tasks) =>
      tasks.map((task) => (task.id === id ? { ...task, ...payload } : task)),
    );
  };

  useEffect(() => {
    downloader.current = new HlsDownloader({
      adapter: BrowserAdapter,
      onEvent: (event: HlsDownloaderEvent, progress) => {
        const targetId = currentDownloadId.current;
        if (!targetId) {
          return;
        }
        if (event === HlsDownloaderEvent.STARTING_DOWNLOAD) {
          setModalOpen(false);
          updateDownloadTask(targetId, { status: 'downloading', percentage: 1 });
          return;
        }
        if (event === HlsDownloaderEvent.DOWNLOADING_SEGMENTS && progress) {
          const percentage = Math.floor(((progress.completed + 1) / progress.total) * 80);
          updateDownloadTask(targetId, {
            status: 'downloading',
            percentage: Math.min(80, Math.max(1, percentage)),
          });
          return;
        }
        if (event === HlsDownloaderEvent.STICHING_SEGMENTS && progress) {
          const percentage = 80 + Math.floor((progress.completed / progress.total) * 20);
          updateDownloadTask(targetId, {
            status: 'downloading',
            percentage: Math.min(99, Math.max(80, percentage)),
          });
          return;
        }
        if (event === HlsDownloaderEvent.READY_FOR_DOWNLOAD) {
          updateDownloadTask(targetId, { status: 'completed', percentage: 100 });
          return;
        }
        if (event === HlsDownloaderEvent.ERROR) {
          updateDownloadTask(targetId, { status: 'failed' });
        }
      },
    });
  }, []);

  const fetchPoster = async (url: string) => {
    try {
      const posterUrl = await downloader.current?.getPosterUrl({
        url,
        headers: Object.keys(headers).length ? headers : undefined,
      });
      if (posterUrl) {
        setMetadata((prev) => (prev ? { ...prev, previewSrc: posterUrl } : prev));
        setDownloadList((tasks) =>
          tasks.map((task) => (!task.previewSrc ? { ...task, previewSrc: posterUrl } : task)),
        );
      }
    } catch {}
  };

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    const reqHeaders = Object.keys(headers).length ? headers : undefined;
    const result = await downloader.current?.parseHls({
      url: values.url,
      headers: reqHeaders,
    });
    if (!result || result.type === 'error') {
      toast.error('解析失败，无效的 HLS 资源链接');
      return;
    }

    const { type, data } = result;

    if (type === 'playlist') {
      if (!data?.length) {
        toast.error('解析失败，无效的 HLS 资源链接');
      } else {
        setMetadata({
          filename: '',
          previewSrc: '',
          playlist: data,
        });
        setModalOpen(true);
        fetchPoster(data[0].uri);
      }
    } else if (type === 'segment') {
      setMetadata({
        filename: '',
        previewSrc: '',
        playlist: [
          {
            name: '默认',
            bandwidth: 0,
            uri: values.url,
          },
        ],
      });
      setModalOpen(true);
      fetchPoster(values.url);
    }
  };

  const onConfirmDownload = async ({ quality, title }: { quality: string; title?: string }) => {
    if (!metadata?.playlist?.length) {
      toast.error('未找到可下载的视频流');
      return;
    }
    const selectedPlaylist =
      metadata.playlist.find((item) => item.name === quality) ?? metadata.playlist[0];
    if (!selectedPlaylist) {
      toast.error('未找到可下载的视频流');
      return;
    }
    const filename = (title || '').trim() || 'output.mp4';
    const taskId = Date.now().toString();
    currentDownloadId.current = taskId;
    setDownloadList((tasks) => {
      const task: IDownloadListItem = {
        id: taskId,
        url: selectedPlaylist.uri,
        title: filename,
        previewSrc: metadata.previewSrc,
        percentage: 0,
        status: 'downloading',
        blobURL: undefined,
      };
      return [task, ...tasks];
    });
    try {
      const result = await downloader.current?.download({
        url: selectedPlaylist.uri,
        headers: Object.keys(headers).length ? headers : undefined,
      });
      if (!result?.blobURL) {
        throw new Error('下载失败');
      }
      updateDownloadTask(taskId, { blobURL: result.blobURL, percentage: 100, status: 'completed' });
      toast.success('下载完成，请点击保存');
    } catch (e) {
      console.error(e);
      updateDownloadTask(taskId, { status: 'failed' });
      toast.error('下载失败，请稍后重试');
    } finally {
      currentDownloadId.current = void 0;
    }
  };

  const onSaveDownload = async (id: string) => {
    const task = downloadList.find((item) => item.id === id);
    if (!task?.blobURL) {
      return;
    }
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
    if (!showSaveFilePicker) {
      toast.error('当前浏览器不支持可感知保存结果的手动保存');
      return;
    }
    try {
      const blob = await fetch(task.blobURL).then((response) => response.blob());
      const handle = await showSaveFilePicker({
        suggestedName: task.title,
        types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      URL.revokeObjectURL(task.blobURL);
      updateDownloadTask(id, { blobURL: undefined, status: 'saved' });
      toast.success('保存成功');
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
        return;
      }
      toast.error('保存失败，请重试');
    }
  };

  return (
    <div className="absolute w-screen h-screen flex flex-col justify-center items-center select-none">
      {platform === Platform.web && (
        <div className="fixed top-6 right-6">
          <ModeToggle />
        </div>
      )}
      <h1 className="text-3xl lg:text-4xl font-bold">HLS Downloader</h1>
      <h2 className="mt-3 max-w-xl text-center md:text-base text-sm">
        下载任何你喜爱的 HLS 视频资源。 请确保资源 uri 为有效的{' '}
        <code className="text-background bg-foreground border boder-gray-200 px-1 rounded-sm">
          .m3u8
        </code>{' '}
        资源。
      </h2>
      <Form {...form}>
        <form className="mb-2" onSubmit={form.handleSubmit(onSubmit)}>
          <FormField
            name="url"
            control={form.control}
            render={({ field, formState }) => (
              <FormItem className="my-3">
                <div className="flex w-full items-center gap-2">
                  <FormControl>
                    <InputGroup>
                      <InputGroupInput
                        className="inline-block w-lg"
                        type="url"
                        placeholder="请输入 HLS 链接"
                        {...field}
                      />
                      <InputGroupAddon align="inline-end">
                        <Button
                          variant="link"
                          type="button"
                          onClick={() => setHeadersModalOpen(true)}
                        >
                          Headers
                        </Button>
                      </InputGroupAddon>
                    </InputGroup>
                  </FormControl>
                  <Button
                    size="lg"
                    type="submit"
                    disabled={formState.isSubmitting || formState.isLoading}
                  >
                    {formState.isSubmitting || formState.isLoading ? (
                      <Loader2Icon className="animate-spin" />
                    ) : (
                      <DownloadIcon />
                    )}
                    {formState.isSubmitting ? '解析中' : '下载'}
                  </Button>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </form>
      </Form>
      <ConfirmModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        metadata={metadata}
        onConfirm={onConfirmDownload}
      />
      <HeadersModal
        open={headersModalOpen}
        onOpenChange={setHeadersModalOpen}
        defaultHeaders={headers}
        onConfirm={setHeaders}
      />
      <DownloadList
        items={downloadList}
        floatButton={platform !== Platform.web}
        onSave={onSaveDownload}
      />
    </div>
  );
}
