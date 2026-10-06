import type { UseFormReturn } from 'react-hook-form';
import type { ConfirmFormValues } from './confirm-modal';
import { FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { cn } from '@/lib/utils';

export function SaveModeFields({
  form,
  disabled,
  fileAvailable,
  outputMode,
  timeline,
}: {
  form: UseFormReturn<ConfirmFormValues>;
  disabled: boolean;
  fileAvailable: boolean;
  outputMode: 'file' | 'browser';
  timeline: boolean;
}) {
  return (
    <>
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
                disabled={disabled}
                className="grid gap-4 sm:grid-cols-2"
                onValueChange={(value) => {
                  field.onChange(value);
                  if (value === 'file') form.setValue('transcodePreset', 'none');
                }}
              >
                <FieldLabel
                  htmlFor="output-file"
                  className={cn(
                    'cursor-pointer transition-colors hover:bg-accent',
                    !fileAvailable && 'opacity-60',
                  )}
                >
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>大文件直存</FieldTitle>
                      <FieldDescription>边下载边写入，节省内存。</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem
                      id="output-file"
                      value="file"
                      disabled={!fileAvailable}
                      aria-describedby="file-output-note"
                    />
                  </Field>
                </FieldLabel>
                <FieldLabel
                  className="cursor-pointer transition-colors hover:bg-accent"
                  htmlFor="output-browser"
                >
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>普通下载</FieldTitle>
                      <FieldDescription>
                        {timeline ? '每个独立输出下载后保存。' : '下载后保存，支持转码。'}
                      </FieldDescription>
                    </FieldContent>
                    <RadioGroupItem id="output-browser" value="browser" />
                  </Field>
                </FieldLabel>
              </RadioGroup>
            </FormControl>
            <p id="file-output-note" className="text-xs text-muted-foreground">
              {!fileAvailable
                ? '此浏览器暂不支持文件直存，请使用普通下载。'
                : outputMode === 'file'
                  ? '保存为原编码 MP4；如需转码，请选普通下载。'
                  : '完整视频保留在内存中，大文件建议直存。'}
            </p>
          </FormItem>
        )}
      />
    </>
  );
}
