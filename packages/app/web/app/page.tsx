'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { DownloadIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import z from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import ConfirmModal, {
  buildBrowserTranscodeOptions,
  type ConfirmFormValues,
} from '@/components/confirm-modal';
import { buildMultiTrackConfig } from '@/lib/multitrack-options';
import { buildTimelineOptions, parseChapters } from '@/lib/timeline-options';
import DownloadList from '@/components/download-list';
import { HeadersModal } from '@/components/headers-modal';
import { ModeToggle } from '@/components/mode-toggle';
import { Platform, usePlatform } from '@/hooks';
import { useDownloadManager } from '@/hooks/use-download-manager';
import { useHlsMetadata } from '@/hooks/use-hls-metadata';
import { useStreamPreview } from '@/hooks/use-stream-preview';

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
  const [modalOpen, setModalOpen] = useState(false);
  const [headersModalOpen, setHeadersModalOpen] = useState(false);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const { metadata, resolveMetadata } = useHlsMetadata();
  const downloads = useDownloadManager(3);
  const {
    preview: streamPreview,
    videoRef,
    open: openStreamPreview,
    close: closeStreamPreview,
  } = useStreamPreview();
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { url: searchParams.get('url') ?? '' },
  });

  const requestHeaders = Object.keys(headers).length > 0 ? headers : undefined;

  const onSubmit = async ({ url }: z.infer<typeof formSchema>) => {
    const resolved = await resolveMetadata(url, requestHeaders);
    if (resolved === null) return;
    if (!resolved) {
      toast.error('解析失败，无效的 HLS 资源链接');
      return;
    }
    setModalOpen(true);
  };

  const getSelection = ({ quality, title }: ConfirmFormValues) => {
    const selected =
      metadata?.playlist.find((item) => item.name === quality) ?? metadata?.playlist[0];
    if (!selected) {
      toast.error('未找到可下载的视频流');
      return undefined;
    }
    return {
      source: {
        // Keep the master URL so the library can resolve its associated audio group.
        url: metadata!.sourceUrl,
        variant: {
          maxBandwidth: selected.bandwidth,
          maxResolution: selected.resolution,
          preferredCodec: selected.codecs?.split(',').find((codec) => /^(avc|hev|hvc)/.test(codec)),
        },
      },
      filename: ((title || '').trim() || 'output').replace(/\.[^/.]+$/, ''),
    };
  };

  const onConfirmDownload = async (values: ConfirmFormValues) => {
    const selection = getSelection(values);
    if (!selection) return false;
    let multiTrack;
    try {
      multiTrack = buildMultiTrackConfig(
        values,
        metadata?.playlist.find((item) => item.name === values.quality),
        metadata?.renditions,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '多轨设置无效');
      return false;
    }
    const transcode = buildBrowserTranscodeOptions(values);
    const extension = transcode?.preset === 'vp9' ? 'webm' : 'mp4';
    const task = {
      ...selection.source,
      filename: selection.filename,
      title: `${selection.filename}.${extension}`,
      previewSrc: metadata?.previewSrc ?? '',
      headers: requestHeaders,
      transcode,
      multiTrack,
      timeline: multiTrack ? undefined : buildTimelineOptions(values),
      chapters:
        !multiTrack && values.timelineMode === 'timeline'
          ? parseChapters(values.chaptersText ?? '')
          : undefined,
      subtitle: (() => {
        const selected = metadata?.playlist.find((item) => item.name === values.quality);
        const rendition = metadata?.renditions?.find(
          (item) =>
            item.type === 'subtitles' &&
            item.groupId === selected?.subtitlesGroup &&
            JSON.stringify([item.groupId, item.name]) === values.subtitle,
        );
        return !multiTrack && values.timelineMode === 'timeline' && rendition
          ? { groupId: rendition.groupId, name: rendition.name }
          : undefined;
      })(),
    };
    if (values.outputMode === 'file') return downloads.enqueueToFile(task);
    downloads.enqueue({ ...task, outputMode: 'browser' });
    return true;
  };

  const onStreamPreview = (values: ConfirmFormValues) => {
    const selection = getSelection(values);
    if (!selection) return;
    setModalOpen(false);
    openStreamPreview(
      selection.source.url,
      selection.filename,
      requestHeaders,
      selection.source.variant,
    );
  };

  return (
    <div className="flex min-h-svh w-full select-none flex-col items-center justify-center px-4 py-20">
      {platform === Platform.web ? (
        <div className="fixed top-6 right-6">
          <ModeToggle />
        </div>
      ) : null}
      <h1 className="text-3xl font-bold lg:text-4xl">HLS Downloader</h1>
      <h2 className="mt-3 max-w-xl text-center text-sm md:text-base">
        下载任何你喜爱的 HLS 视频资源。 请确保资源 uri 为有效的{' '}
        <code className="text-background bg-foreground rounded-sm border px-1">.m3u8</code> 资源。
      </h2>
      <Form {...form}>
        <form className="mb-2 w-full max-w-2xl" onSubmit={form.handleSubmit(onSubmit)}>
          <FormField
            name="url"
            control={form.control}
            render={({ field, formState }) => (
              <FormItem className="my-3">
                <div className="flex w-full items-center gap-2">
                  <FormControl>
                    <InputGroup>
                      <InputGroupInput
                        className="min-w-0 w-full"
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
                      <Loader2Icon data-icon="inline-start" className="animate-spin" />
                    ) : (
                      <DownloadIcon data-icon="inline-start" />
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
        canWriteToFile={downloads.canWriteToFile}
        canWriteToDirectory={downloads.canWriteToDirectory}
        onStreamPreview={onStreamPreview}
      />
      <HeadersModal
        open={headersModalOpen}
        onOpenChange={setHeadersModalOpen}
        defaultHeaders={headers}
        onConfirm={setHeaders}
      />
      <DownloadList
        items={downloads.tasks}
        floatButton={platform !== Platform.web}
        onSave={downloads.save}
        onSaveArtifact={downloads.saveArtifact}
        onCancel={downloads.cancel}
        onRemove={downloads.remove}
      />
      <Dialog open={streamPreview.open} onOpenChange={(open) => !open && closeStreamPreview()}>
        <DialogContent
          className="sm:max-w-2xl"
          overlayClassName="supports-backdrop-filter:backdrop-blur-none"
        >
          <DialogHeader>
            <DialogTitle>预览 · {streamPreview.title}</DialogTitle>
          </DialogHeader>
          <div className="relative isolate aspect-video w-full overflow-hidden rounded-lg">
            <video
              ref={videoRef}
              className={
                streamPreview.loading
                  ? 'invisible size-full rounded-lg bg-black'
                  : 'size-full rounded-lg bg-black'
              }
              controls={!streamPreview.loading}
              autoPlay
              playsInline
            />
            {streamPreview.loading ? (
              <Skeleton className="absolute inset-0 size-full rounded-lg" />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
