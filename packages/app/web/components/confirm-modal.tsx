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
import { Skeleton } from '@/components/ui/skeleton';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { toast } from 'sonner';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Loader2Icon } from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';

import type { HlsDownloaderBrowserTranscodeOptions } from '@hls-downloader/adapters/browser';
import type { Playlist } from '@hls-downloader/shared';

export const confirmFormSchema = z.object({
  quality: z.string(),
  title: z.string(),
  outputMode: z.enum(['browser', 'file']),
  transcodePreset: z.enum(['none', 'h264', 'hevc', 'vp9']),
  videoBitrate: z.string().optional(),
  audioBitrate: z.string().optional(),
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
  };
  onOpenChange?: (open: boolean) => void;
  canWriteToFile?: boolean;
  onConfirm?: (form: ConfirmFormValues) => Promise<boolean>;
  onStreamPreview?: (form: ConfirmFormValues) => void;
}

export const ConfirmModal = ({
  open,
  metadata,
  onOpenChange,
  onConfirm,
  onStreamPreview,
  canWriteToFile = false,
}: IConfirmModalProps) => {
  const { filename, previewSrc, playlist } = metadata || {};
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isLoading = Boolean(open && !previewSrc);
  const form = useForm<ConfirmFormValues>({
    resolver: zodResolver(confirmFormSchema),
    values: {
      title: filename || '',
      quality: playlist?.[0]?.name ?? '',
      outputMode: canWriteToFile ? 'file' : 'browser',
      transcodePreset: 'none',
      videoBitrate: '',
      audioBitrate: '',
    },
  });

  const outputMode = useWatch({ control: form.control, name: 'outputMode' });
  const transcodePreset = useWatch({ control: form.control, name: 'transcodePreset' });
  const showBitrateFields = transcodePreset !== 'none';

  const handleConfirm = async (values: ConfirmFormValues) => {
    setIsSubmitting(true);
    try {
      if (await onConfirm?.(values)) onOpenChange?.(false);
    } catch {
      toast.error('无法创建下载任务，请重试');
    }
    setIsSubmitting(false);
  };

  const submitDownload = () => {
    if (isSubmitting) return;
    // Validate synchronously so the native picker opens in the click gesture.
    const result = confirmFormSchema.safeParse(form.getValues());
    if (result.success) void handleConfirm(result.data);
    else void form.trigger();
  };

  const handleStreamPreview = (values: ConfirmFormValues) => {
    onStreamPreview?.(values);
  };

  return (
    <AlertDialog open={open} onOpenChange={(value) => !isSubmitting && onOpenChange?.(value)}>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto gap-3 sm:max-w-[520px]">
        <AlertDialogHeader>
          <AlertDialogTitle>确认下载</AlertDialogTitle>
          <AlertDialogDescription>确认视频信息并选择下载设置</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="overflow-hidden rounded-xl">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            previewSrc && <img className="h-40 w-full object-cover" src={previewSrc} alt="poster" />
          )}
        </div>
        <Form {...form}>
          <form
            id="confirm-modal-form"
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitDownload();
            }}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <FormField
                name="title"
                control={form.control}
                render={({ field }) => (
                  <FormItem className="gap-1">
                    <FormLabel className="text-xs">文件标题</FormLabel>
                    <FormControl>
                      <Input {...field} className="h-8" type="text" placeholder="output" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {playlist && playlist.length > 0 && (
                <FormField
                  name="quality"
                  control={form.control}
                  render={({ field }) => (
                    <FormItem className="gap-1">
                      <FormLabel className="text-xs">视频质量</FormLabel>
                      <FormControl>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="w-full" size="sm">
                            <SelectValue placeholder="选择视频质量" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {playlist.map(({ name, bandwidth }) => (
                                <SelectItem key={`${name}-${bandwidth}`} value={name}>
                                  {name}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}
            </div>
            <FormField
              name="outputMode"
              control={form.control}
              render={({ field }) => (
                <FormItem className="gap-2">
                  <FormLabel>保存方式</FormLabel>
                  <FormControl>
                    <RadioGroup
                      aria-label="保存方式"
                      value={field.value}
                      disabled={isSubmitting}
                      className="grid gap-2 sm:grid-cols-2"
                      onValueChange={(value) => {
                        field.onChange(value);
                        if (value === 'file') form.setValue('transcodePreset', 'none');
                      }}
                    >
                      <FieldLabel
                        htmlFor="output-file"
                        className={!canWriteToFile ? 'opacity-60' : undefined}
                      >
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldTitle>大文件直存</FieldTitle>
                            <FieldDescription>
                              先选位置，边下载边写入，降低内存占用。
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem
                            id="output-file"
                            value="file"
                            disabled={!canWriteToFile}
                            aria-describedby="file-output-note"
                          />
                        </Field>
                      </FieldLabel>
                      <FieldLabel htmlFor="output-browser">
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldTitle>普通下载</FieldTitle>
                            <FieldDescription>下载完成后手动保存，可选择转码。</FieldDescription>
                          </FieldContent>
                          <RadioGroupItem id="output-browser" value="browser" />
                        </Field>
                      </FieldLabel>
                    </RadioGroup>
                  </FormControl>
                  <p id="file-output-note" className="text-xs text-muted-foreground">
                    {!canWriteToFile
                      ? '此浏览器暂不支持文件直存，请使用普通下载；也可在安全连接下使用支持文件选择器的浏览器。'
                      : outputMode === 'file'
                        ? '直接保存为 MP4，保留原始编码。需要转码时，请选择普通下载。'
                        : '普通下载会在内存中保留完整视频，大文件建议使用直存。'}
                  </p>
                </FormItem>
              )}
            />
            <FormField
              name="transcodePreset"
              control={form.control}
              render={({ field }) => (
                <FormItem className="gap-1">
                  <FormLabel className="text-xs">转码预设</FormLabel>
                  <FormControl>
                    <ToggleGroup
                      variant="outline"
                      size="sm"
                      disabled={outputMode === 'file' || isSubmitting}
                      className="w-full"
                      value={field.value ? [field.value] : []}
                      onValueChange={(value) => value[0] && field.onChange(value[0])}
                    >
                      <ToggleGroupItem className="flex-1" value="none">
                        默认
                      </ToggleGroupItem>
                      <ToggleGroupItem className="flex-1" value="h264">
                        H.264
                      </ToggleGroupItem>
                      <ToggleGroupItem className="flex-1" value="hevc">
                        HEVC
                      </ToggleGroupItem>
                      <ToggleGroupItem className="flex-1" value="vp9">
                        VP9
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </FormControl>
                </FormItem>
              )}
            />
            {showBitrateFields ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <FormField
                  name="videoBitrate"
                  control={form.control}
                  render={({ field }) => (
                    <FormItem className="gap-1">
                      <FormLabel className="text-xs">视频码率（可选）</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          className="h-8"
                          type="text"
                          placeholder="如 4M"
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  name="audioBitrate"
                  control={form.control}
                  render={({ field }) => (
                    <FormItem className="gap-1">
                      <FormLabel className="text-xs">音频码率（可选）</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          className="h-8"
                          type="text"
                          placeholder="如 128k"
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            ) : null}
          </form>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="cursor-pointer"
              size="sm"
              disabled={isSubmitting}
              onClick={() => onOpenChange?.(false)}
            >
              取消
            </AlertDialogCancel>
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={isSubmitting}
              onClick={form.handleSubmit(handleStreamPreview)}
            >
              {isSubmitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              直接播放
            </Button>
            <Button
              form="confirm-modal-form"
              className="cursor-pointer"
              size="sm"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {isSubmitting
                ? '正在选择保存位置…'
                : outputMode === 'file'
                  ? '选择位置并下载'
                  : '下载'}
            </Button>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default ConfirmModal;
