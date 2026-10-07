import { useWatch, type UseFormReturn } from 'react-hook-form';
import type { Playlist, Rendition } from '@hls-downloader/shared';
import type { ConfirmFormValues } from './confirm-modal';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FieldGroup, FieldDescription } from '@/components/ui/field';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

export function TimelineSettings({
  form,
  playlist,
  renditions,
  canWriteToDirectory,
}: {
  form: UseFormReturn<ConfirmFormValues>;
  playlist?: Playlist[];
  renditions?: Rendition[];
  canWriteToDirectory: boolean;
}) {
  const multi = useWatch({ control: form.control, name: 'trackMode' }) === 'multi';
  const timelineMode = useWatch({ control: form.control, name: 'timelineMode' });
  const quality = useWatch({ control: form.control, name: 'quality' });
  const subtitlesGroup = playlist?.find((item) => item.name === quality)?.subtitlesGroup;
  const subtitles =
    renditions?.filter(
      (item) => item.type === 'subtitles' && item.uri && item.groupId === subtitlesGroup,
    ) ?? [];
  return (
    <>
      <FormField
        name="timelineMode"
        control={form.control}
        render={({ field }) => (
          <FormItem>
            <FormLabel>下载范围</FormLabel>
            <FormControl>
              <ToggleGroup
                multiple={false}
                value={[field.value ?? 'legacy']}
                onValueChange={(value) => {
                  if (!value[0]) return;
                  field.onChange(value[0]);
                  if (value[0] === 'timeline') form.setValue('transcodePreset', 'none');
                }}
                aria-label="下载范围"
              >
                <ToggleGroupItem value="legacy">完整下载</ToggleGroupItem>
                <ToggleGroupItem value="timeline">时间轴下载</ToggleGroupItem>
              </ToggleGroup>
            </FormControl>
          </FormItem>
        )}
      />
      {timelineMode === 'timeline' && (
        <FieldGroup>
          <FieldDescription>
            {multi
              ? '按多轨媒体时间轴处理范围、缺口和配置变化；不逐帧裁切。'
              : '先扫描并验证时间轴，再开始输出。范围按可解码边界扩展；不逐帧裁切。当前直接播放与转码仅适用于完整下载。'}{' '}
            留空起止时间表示整个资源。
          </FieldDescription>
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ['rangeStart', '开始时间（秒）'],
                ['rangeEnd', '结束时间（秒，不含）'],
              ] as const
            ).map(([name, label]) => (
              <FormField
                key={name}
                name={name}
                control={form.control}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{label}</FormLabel>
                    <FormControl>
                      <Input {...field} inputMode="decimal" placeholder="留空表示整个资源" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            {(
              [
                [
                  'gapPolicy',
                  '缺口处理',
                  [
                    ['preserve', '保留缺口'],
                    ['collapse', '压缩缺口'],
                  ],
                ],
                [
                  'changePolicy',
                  '配置变化',
                  [
                    ['fail', '失败并提示'],
                    ['split', '拆分独立文件'],
                  ],
                ],
              ] as const
            ).map(([name, label, choices]) => (
              <FormField
                key={name}
                name={name}
                control={form.control}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{label}</FormLabel>
                    <FormControl>
                      <Select
                        value={field.value}
                        onValueChange={(value) => {
                          field.onChange(value);
                          if (name === 'changePolicy' && value === 'split' && !canWriteToDirectory)
                            form.setValue('outputMode', 'browser');
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {choices.find(([value]) => value === field.value)?.[1]}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {choices.map(([value, text]) => (
                              <SelectItem key={value} value={value}>
                                {text}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormItem>
                )}
              />
            ))}
          </FieldGroup>
          {!multi && (
            <>
              <FormField
                name="subtitle"
                control={form.control}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>WebVTT 字幕</FormLabel>
                    <FormControl>
                      <Select
                        value={
                          subtitles.some(
                            (item) => JSON.stringify([item.groupId, item.name]) === field.value,
                          )
                            ? field.value
                            : 'none'
                        }
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {subtitles.find(
                              (item) => JSON.stringify([item.groupId, item.name]) === field.value,
                            )?.name ?? '不导出字幕'}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="none">不导出字幕</SelectItem>
                            {subtitles.map((item) => (
                              <SelectItem
                                key={JSON.stringify([item.groupId, item.name])}
                                value={JSON.stringify([item.groupId, item.name])}
                              >
                                {item.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FieldDescription>
                      跟随已完成媒体报告，按输出拆分。同步证据不足时单独显示导出失败。
                    </FieldDescription>
                  </FormItem>
                )}
              />
              <FormField
                name="chaptersText"
                control={form.control}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>章节（可选）</FormLabel>
                    <FormControl>
                      <Textarea {...field} placeholder="0 --> 30 | 开场&#10;30 --> 60 | 正文" />
                    </FormControl>
                    <FieldDescription>
                      每行填写公共时间轴秒数：开始 --&gt; 结束 | 标题
                    </FieldDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}
          <Accordion>
            <AccordionItem value="timeline-advanced">
              <AccordionTrigger>高级时间轴设置</AccordionTrigger>
              <AccordionContent>
                <FormField
                  name="timelineAdvanced"
                  control={form.control}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>锚点、预算与尾帧时长（JSON）</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder={'{"limits":{"samples":500000,"resources":2000}}'}
                        />
                      </FormControl>
                      <FieldDescription>
                        {multi
                          ? '可填写 anchors（inputId、generation、epoch、source、presentation）、limits、tailDuration；input ID 见默认轨及字幕绑定。'
                          : '可填写 epochAnchors、limits、tailDuration；预算限制规划量，并非内存上限。'}{' '}
                        时间使用 ticks 字符串与 timescale。
                      </FieldDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </FieldGroup>
      )}
    </>
  );
}
