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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Field, FieldContent, FieldLabel, FieldTitle } from '@/components/ui/field';
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
});

export const ConfirmModal = ({ open, metadata, onOpenChange, onConfirm }: IConfirmModalProps) => {
  const { filename, previewSrc, playlist } = metadata || {};
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    values: { title: filename || '', quality: playlist?.[0]?.name ?? '' },
  });

  const handleConfirm = async (values: z.infer<typeof formSchema>) => {
    setIsSubmitting(true);
    await onConfirm?.(values);
    setIsSubmitting(false);
    onOpenChange?.(false);
  };

  useEffect(() => {
    if (open && previewSrc) {
      setIsLoading(true);
      const image = new Image();
      image.onload = () => setIsLoading(false);
      image.src = previewSrc;
    }
  }, [open, previewSrc]);

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle>确认下载</AlertDialogTitle>
          <AlertDialogDescription>
            获取到 HLS 视频资源预览如下，是否下载该视频资源
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="rounded-xl overflow-hidden">
          {isLoading ? (
            <Skeleton className="w-full h-[125px]" />
          ) : (
            previewSrc && <img className="object-cover w-full" src={previewSrc} alt="poster" />
          )}
        </div>
        <Form {...form}>
          <form id="confirm-modal-form" onSubmit={form.handleSubmit(handleConfirm)}>
            <FormField
              name="title"
              control={form.control}
              render={({ field }) => (
                <FormItem className="mb-3">
                  <FormLabel>文件标题</FormLabel>
                  <FormControl>
                    <Input {...field} type="text" placeholder="output.mp4" />
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
                  <FormItem>
                    <FormLabel>视频质量</FormLabel>
                    <FormControl>
                      <RadioGroup {...field}>
                        {playlist.map(({ name, bandwidth }) => (
                          <FieldLabel key={bandwidth} htmlFor={name}>
                            <Field orientation="horizontal">
                              <FieldContent>
                                <FieldTitle>{name}</FieldTitle>
                              </FieldContent>
                              <RadioGroupItem value={name} id={name} />
                            </Field>
                          </FieldLabel>
                        ))}
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />
            )}
          </form>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer" onClick={() => onOpenChange?.(false)}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              form="confirm-modal-form"
              className="cursor-pointer"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting && <Loader2Icon className="animate-spin" />}
              确定
            </AlertDialogAction>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default ConfirmModal;
