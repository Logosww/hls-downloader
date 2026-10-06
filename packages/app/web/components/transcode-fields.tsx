import { useWatch, type UseFormReturn } from 'react-hook-form';
import type { ConfirmFormValues } from './confirm-modal';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FieldGroup } from '@/components/ui/field';

export function TranscodeFields({
  form,
  disabled,
}: {
  form: UseFormReturn<ConfirmFormValues>;
  disabled: boolean;
}) {
  const transcodePreset = useWatch({ control: form.control, name: 'transcodePreset' });
  const showBitrateFields = transcodePreset !== 'none';
  return (
    <>
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
                disabled={disabled}
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
                  <Input {...field} type="text" placeholder="如 4M" value={field.value ?? ''} />
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
                  <Input {...field} type="text" placeholder="如 128k" value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </FieldGroup>
      ) : null}
    </>
  );
}
