import type { UseFormReturn } from 'react-hook-form';
import type { ConfirmFormValues } from './confirm-modal';
import { FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Radio, RadioField, RadioGroup } from '@/components/ui/radio';
import { Description } from '@/components/ui/field';

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
    <FormField
      name="outputMode"
      control={form.control}
      render={({ field }) => (
        <FormItem>
          <FormLabel>保存方式</FormLabel>
          <FormControl>
            <RadioGroup
              value={field.value}
              isDisabled={disabled}
              aria-describedby="file-output-note"
              onChange={(value) => {
                field.onChange(value);
                if (value === 'file') form.setValue('transcodePreset', 'none');
              }}
            >
              <RadioField value="file" isDisabled={!fileAvailable}>
                <Radio>大文件直存</Radio>
                <Description>边下载边写入，节省内存。</Description>
              </RadioField>
              <RadioField value="browser">
                <Radio>普通下载</Radio>
                <Description>
                  {timeline ? '每个独立输出下载后保存。' : '下载后保存，支持转码。'}
                </Description>
              </RadioField>
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
  );
}
