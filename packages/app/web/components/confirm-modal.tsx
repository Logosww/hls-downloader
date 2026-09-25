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
  FieldGroup,
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
  const [isDownloading, setIsDownloading] = useState(false);
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
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto gap-5 data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>确认下载</AlertDialogTitle>
          <AlertDialogDescription>确认视频信息并选择下载设置</AlertDialogDescription>
        </AlertDialogHeader>
        <Form {...form}>
          <form
            id="confirm-modal-form"
            className="flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              submitDownload();
            }}
          >
            <FieldGroup className="grid items-start gap-4 sm:grid-cols-2">
              <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-muted">
                {isLoading ? (
                  <Skeleton className="absolute inset-0 size-full" />
                ) : (
                  previewSrc && (
                    <img
                      className="absolute inset-0 size-full object-contain"
                      src={previewSrc}
                      alt="视频封面"
                    />
                  )
                )}
              </div>
              <FieldGroup className="min-w-0">
                <FormField
                  name="title"
                  control={form.control}
                  render={({ field }) => (
                    <FormItem className="gap-2">
                      <FormLabel>文件标题</FormLabel>
                      <FormControl>
                        <Input {...field} type="text" placeholder="output" />
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
                      <FormItem className="gap-2">
                        <FormLabel>视频质量</FormLabel>
                        <FormControl>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger className="w-full">
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
              </FieldGroup>
            </FieldGroup>
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
                      disabled={isDownloading}
                      className="grid gap-4 sm:grid-cols-2"
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
                            <FieldDescription>边下载边写入，节省内存。</FieldDescription>
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
                            <FieldDescription>下载后保存，支持转码。</FieldDescription>
                          </FieldContent>
                          <RadioGroupItem id="output-browser" value="browser" />
                        </Field>
                      </FieldLabel>
                    </RadioGroup>
                  </FormControl>
                  <p id="file-output-note" className="text-xs text-muted-foreground">
                    {!canWriteToFile
                      ? '此浏览器暂不支持文件直存，请使用普通下载。'
                      : outputMode === 'file'
                        ? '保存为原编码 MP4；如需转码，请选普通下载。'
                        : '完整视频保留在内存中，大文件建议直存。'}
                  </p>
                </FormItem>
              )}
            />
            <FormField
              name="transcodePreset"
              control={form.control}
              render={({ field }) => (
                <FormItem className="gap-2">
                  <FormLabel>转码预设</FormLabel>
                  <FormControl>
                    <ToggleGroup
                      variant="outline"
                      size="sm"
                      disabled={outputMode === 'file' || isDownloading}
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
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <FormField
                  name="videoBitrate"
                  control={form.control}
                  render={({ field }) => (
                    <FormItem className="gap-2">
                      <FormLabel>视频码率（可选）</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
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
                    <FormItem className="gap-2">
                      <FormLabel>音频码率（可选）</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="text"
                          placeholder="如 128k"
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FieldGroup>
            ) : null}
          </form>
          <AlertDialogFooter>
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
              disabled={isDownloading}
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
              {isDownloading
                ? outputMode === 'file'
                  ? '正在选择保存位置…'
                  : '正在创建下载…'
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
