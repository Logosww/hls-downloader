import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogHeader,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
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

import type { Playlist } from '@hls-downloader/adapters';

export interface IConfirmModalProps {
  open?: boolean;
  metadata?: {
    filename: string;
    previewSrc: string;
    playlist: Playlist[];
  };
  onOpenChange?: (open: boolean) => void;
  onConfirm?: (form: z.infer<typeof formSchema>) => Promise<void>;
}
const formSchema = z.object({
  quality: z.string(),
  title: z.string(),
  transcodePreset: z.enum(['none', 'h264']),
});

export const ConfirmModal = ({ open, metadata, onOpenChange, onConfirm }: IConfirmModalProps) => {
  const { filename, previewSrc, playlist } = metadata || {};
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    values: {
      title: filename || '',
      quality: playlist?.[0]?.name ?? '',
      transcodePreset: 'none',
    },
  });

  const handleConfirm = async (values: z.infer<typeof formSchema>) => {
    setIsSubmitting(true);
    await onConfirm?.(values);
    setIsSubmitting(false);
    onOpenChange?.(false);
  };

  useEffect(() => {
    if (open && previewSrc) {
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }
  }, [open, previewSrc]);

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="gap-3 sm:max-w-[460px]">
        <AlertDialogHeader>
          <AlertDialogTitle>确认下载</AlertDialogTitle>
          <AlertDialogDescription>确认视频信息并选择下载设置</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="overflow-hidden rounded-xl">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            previewSrc && (
              <img className="h-40 w-full object-cover" src={previewSrc} alt="poster" />
            )
          )}
        </div>
        <Form {...form}>
          <form
            id="confirm-modal-form"
            className="flex flex-col gap-2"
            onSubmit={form.handleSubmit(handleConfirm)}
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
              name="transcodePreset"
              control={form.control}
              render={({ field }) => (
                <FormItem className="gap-1">
                  <FormLabel className="text-xs">转码预设</FormLabel>
                  <FormControl>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      value={field.value}
                      onValueChange={(value) => value && field.onChange(value)}
                    >
                      <ToggleGroupItem className="flex-1" value="none">
                        默认
                      </ToggleGroupItem>
                      <ToggleGroupItem className="flex-1" value="h264">
                        H.264
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </FormControl>
                </FormItem>
              )}
            />
          </form>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="cursor-pointer"
              size="sm"
              onClick={() => onOpenChange?.(false)}
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              form="confirm-modal-form"
              className="cursor-pointer"
              size="sm"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              确定
            </AlertDialogAction>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default ConfirmModal;
