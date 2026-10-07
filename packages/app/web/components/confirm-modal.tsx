import {
  AlertDialog,
  AlertDialogHeader,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { MultiTrackFields } from './multitrack-fields';
import { multiTrackAdvancedSchema } from '@/lib/multitrack-options';
import { MediaSelectionFields } from './media-selection-fields';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { toast } from 'sonner';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { Form } from '@/components/ui/form';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TimelineSettings } from './timeline-settings';
import { TranscodeFields } from './transcode-fields';
import { buildTimelineOptions, parseChapters } from '@/lib/timeline-options';

import { Loader2Icon } from 'lucide-react';
import { SaveModeFields } from './save-mode-fields';

import type { HlsDownloaderBrowserTranscodeOptions } from '@hls-downloader/adapters/browser';
import type { Playlist, Rendition } from '@hls-downloader/shared';

export const confirmFormSchema = z
  .object({
    trackMode: z.enum(['single', 'multi']).optional(),
    embeddedAudio: z.enum(['keep', 'exclude']).optional(),
    audioTracks: z.array(z.string()).max(31).optional(),
    embeddedSubtitles: z.array(z.string()).max(32).optional(),
    defaultAudio: z.string().optional(),
    defaultSubtitle: z.string().optional(),
    subtitleBindings: z.record(z.string(), z.string()).optional(),
    memoryLimitMiB: z.string().optional(),
    quality: z.string(),
    title: z.string(),
    outputMode: z.enum(['browser', 'file']),
    transcodePreset: z.enum(['none', 'h264', 'hevc', 'vp9']),
    videoBitrate: z.string().optional(),
    audioBitrate: z.string().optional(),
    timelineMode: z.enum(['legacy', 'timeline']).optional(),
    rangeStart: z.string().optional(),
    rangeEnd: z.string().optional(),
    gapPolicy: z.enum(['preserve', 'collapse']).optional(),
    changePolicy: z.enum(['fail', 'split']).optional(),
    timelineAdvanced: z.string().optional(),
    chaptersText: z.string().optional(),
    subtitle: z.string().optional(),
  })
  .superRefine((values, context) => {
    if (values.trackMode === 'multi') {
      if (values.transcodePreset !== 'none')
        context.addIssue({
          code: 'custom',
          path: ['transcodePreset'],
          message: '多轨下载不支持转码',
        });
      const memory = Number(values.memoryLimitMiB ?? '512');
      if (!Number.isInteger(memory) || memory < 1 || memory > 4096)
        context.addIssue({
          code: 'custom',
          path: ['memoryLimitMiB'],
          message: '内存上限须为 1–4096 MiB',
        });
      try {
        if (values.timelineAdvanced?.trim())
          multiTrackAdvancedSchema.parse(JSON.parse(values.timelineAdvanced));
      } catch {
        context.addIssue({
          code: 'custom',
          path: ['timelineAdvanced'],
          message: '多轨高级设置无效，请检查 anchors、limits 与 tailDuration',
        });
      }
    }
    if (values.timelineMode !== 'timeline') return;
    try {
      buildTimelineOptions({
        ...values,
        timelineAdvanced: values.trackMode === 'multi' ? '' : values.timelineAdvanced,
      });
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: [
          error instanceof z.ZodError || error instanceof SyntaxError
            ? 'timelineAdvanced'
            : 'rangeEnd',
        ],
        message:
          error instanceof z.ZodError || error instanceof SyntaxError
            ? '高级时间轴设置无效，请检查 JSON、锚点、预算与尾帧时长'
            : error instanceof Error
              ? error.message
              : '时间轴选项无效',
      });
    }
    try {
      if (values.trackMode !== 'multi') parseChapters(values.chaptersText ?? '');
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['chaptersText'],
        message: error instanceof Error ? error.message : '章节格式无效',
      });
    }
    if (values.transcodePreset !== 'none')
      context.addIssue({
        code: 'custom',
        path: ['transcodePreset'],
        message: '时间轴下载不支持转码',
      });
  });

export type ConfirmFormValues = z.infer<typeof confirmFormSchema>;

export function buildBrowserTranscodeOptions(
  values: ConfirmFormValues,
): HlsDownloaderBrowserTranscodeOptions | undefined {
  if (values.transcodePreset === 'none') {
    return undefined;
  }

  const videoBitrate = values.videoBitrate?.trim();
  const audioBitrate = values.audioBitrate?.trim();

  return {
    preset: values.transcodePreset,
    ...(videoBitrate ? { videoBitrate } : {}),
    ...(audioBitrate ? { audioBitrate } : {}),
  };
}

export interface IConfirmModalProps {
  open?: boolean;
  metadata?: {
    filename: string;
    previewSrc: string;
    playlist: Playlist[];
    renditions?: Rendition[];
  };
  onOpenChange?: (open: boolean) => void;
  canWriteToFile?: boolean;
  canWriteToDirectory?: boolean;
  onConfirm?: (form: ConfirmFormValues) => Promise<boolean>;
  onStreamPreview?: (form: ConfirmFormValues) => void;
}

function downloadButtonLabel(busy: boolean, output: 'file' | 'browser', split: boolean) {
  if (busy) return output === 'file' ? '正在选择保存位置…' : '正在创建下载…';
  if (output === 'browser') return '下载';
  return split ? '选择文件夹并下载' : '选择位置并下载';
}

export const ConfirmModal = ({
  open,
  metadata,
  onOpenChange,
  onConfirm,
  onStreamPreview,
  canWriteToFile = false,
  canWriteToDirectory = false,
}: IConfirmModalProps) => {
  const { filename, previewSrc, playlist } = metadata || {};
  const [isDownloading, setIsDownloading] = useState(false);
  const isLoading = Boolean(open && !metadata);
  const form = useForm<ConfirmFormValues>({
    resolver: zodResolver(confirmFormSchema),
    values: {
      title: filename || '',
      quality: playlist?.[0]?.name ?? '',
      outputMode: canWriteToFile ? 'file' : 'browser',
      transcodePreset: 'none',
      videoBitrate: '',
      audioBitrate: '',
      timelineMode: 'legacy',
      rangeStart: '',
      rangeEnd: '',
      gapPolicy: 'preserve',
      changePolicy: 'fail',
      timelineAdvanced: '',
      chaptersText: '',
      subtitle: 'none',
      trackMode: 'single',
      embeddedAudio: 'keep',
      audioTracks: [],
      embeddedSubtitles: [],
      defaultAudio: 'auto',
      defaultSubtitle: 'none',
      subtitleBindings: {},
      memoryLimitMiB: '512',
    },
  });

  const trackMode = useWatch({ control: form.control, name: 'trackMode' });
  const outputMode = useWatch({ control: form.control, name: 'outputMode' });
  const timelineMode = useWatch({ control: form.control, name: 'timelineMode' });
  const changePolicy = useWatch({ control: form.control, name: 'changePolicy' });
  const advancedMode = timelineMode === 'timeline' || trackMode === 'multi';
  const fileAvailable =
    canWriteToFile && (!advancedMode || changePolicy !== 'split' || canWriteToDirectory);

  const handleConfirm = async (values: ConfirmFormValues) => {
    setIsDownloading(true);
    try {
      if (await onConfirm?.(values)) onOpenChange?.(false);
    } catch {
      toast.error('无法创建下载任务，请重试');
    }
    setIsDownloading(false);
  };

  const submitDownload = () => {
    if (isDownloading) return;
    // Validate synchronously so the native picker opens in the click gesture.
    const result = confirmFormSchema.safeParse(form.getValues());
    if (result.success) void handleConfirm(result.data);
    else void form.trigger();
  };

  const handleStreamPreview = (values: ConfirmFormValues) => {
    onStreamPreview?.(values);
  };

  return (
    <AlertDialog open={open} onOpenChange={(value) => !isDownloading && onOpenChange?.(value)}>
      <AlertDialogContent className="max-h-[min(40rem,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] px-0 overflow-hidden gap-5 data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-2xl">
        <AlertDialogHeader className="px-4">
          <AlertDialogTitle>确认下载</AlertDialogTitle>
          <AlertDialogDescription>确认视频信息并选择下载设置</AlertDialogDescription>
        </AlertDialogHeader>
        <Form {...form}>
          <ScrollArea className="min-h-0">
            <form
              id="confirm-modal-form"
              className="flex flex-col gap-5 px-4 py-1"
              onSubmit={(event) => {
                event.preventDefault();
                submitDownload();
              }}
            >
              <MediaSelectionFields
                form={form}
                previewSrc={previewSrc}
                playlist={playlist}
                isLoading={isLoading}
              />
              <MultiTrackFields form={form} playlist={playlist} renditions={metadata?.renditions} />
              <TimelineSettings
                form={form}
                playlist={playlist}
                renditions={metadata?.renditions}
                canWriteToDirectory={canWriteToDirectory}
              />
              <SaveModeFields
                form={form}
                disabled={isDownloading}
                fileAvailable={fileAvailable}
                outputMode={outputMode}
                timeline={advancedMode}
              />
              <TranscodeFields
                form={form}
                disabled={outputMode === 'file' || advancedMode || isDownloading}
              />
            </form>
          </ScrollArea>
          <AlertDialogFooter className="mx-0">
            <AlertDialogCancel
              className="cursor-pointer"
              size="sm"
              disabled={isDownloading}
              onClick={() => onOpenChange?.(false)}
            >
              取消
            </AlertDialogCancel>
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={isDownloading || advancedMode}
              onClick={form.handleSubmit(handleStreamPreview)}
            >
              直接播放
            </Button>
            <Button
              form="confirm-modal-form"
              className="cursor-pointer"
              size="sm"
              type="submit"
              disabled={isDownloading}
            >
              {isDownloading && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {downloadButtonLabel(
                isDownloading,
                outputMode,
                advancedMode && changePolicy === 'split',
              )}
            </Button>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default ConfirmModal;
