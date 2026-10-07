import type { UseFormReturn } from 'react-hook-form';
import type { Playlist } from '@hls-downloader/shared';
import type { ConfirmFormValues } from './confirm-modal';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldGroup } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';

export function MediaSelectionFields({
  form,
  previewSrc,
  playlist,
  isLoading,
}: {
  form: UseFormReturn<ConfirmFormValues>;
  previewSrc?: string;
  playlist?: Playlist[];
  isLoading: boolean;
}) {
  return (
    <>
      {' '}
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
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        form.setValue('audioTracks', []);
                        form.setValue('embeddedSubtitles', []);
                        form.setValue('defaultAudio', 'auto');
                        form.setValue('defaultSubtitle', 'none');
                        form.setValue('subtitleBindings', {});
                      }}
                    >
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
    </>
  );
}
