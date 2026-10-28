import { useWatch, type UseFormReturn } from 'react-hook-form';
import type { Playlist, Rendition } from '@hls-downloader/shared';
import type { ConfirmFormValues } from './confirm-modal';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectSection,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FieldGroup, Description } from '@/components/ui/field';
import {
  DisclosureGroup,
  DisclosurePanel,
  Disclosure,
  DisclosureTrigger,
} from '@/components/ui/disclosure-group';

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
                size="sm"
                selectionMode="single"
                selectedKeys={[field.value ?? 'legacy']}
                disallowEmptySelection
                onSelectionChange={(keys) => {
                  const value = [...keys];
                  if (!value[0]) return;
                  field.onChange(value[0]);
                  if (value[0] === 'timeline') form.setValue('transcodePreset', 'none');
                }}
                aria-label="下载范围"
              >
                <ToggleGroupItem id="legacy">完整下载</ToggleGroupItem>
                <ToggleGroupItem id="timeline">时间轴下载</ToggleGroupItem>
              </ToggleGroup>
            </FormControl>
          </FormItem>
        )}
      />
      {timelineMode === 'timeline' && (
        <FieldGroup>
          <Description>
            {multi
              ? '按多轨媒体时间轴处理范围、缺口和配置变化；不逐帧裁切。'
              : '先扫描并验证时间轴，再开始输出。范围按可解码边界扩展；不逐帧裁切。当前直接播放与转码仅适用于完整下载。'}{' '}
            留空起止时间表示整个资源。
          </Description>
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
                        onChange={(value) => {
                          field.onChange(value);
                          if (name === 'changePolicy' && value === 'split' && !canWriteToDirectory)
                            form.setValue('outputMode', 'browser');
                        }}
                      >
                        <SelectTrigger className="w-full" />
                        <SelectContent>
                          <SelectSection>
                            {choices.map(([value, text]) => (
                              <SelectItem key={value} id={value}>
                                {text}
                              </SelectItem>
                            ))}
                          </SelectSection>
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
                        onChange={field.onChange}
                      >
                        <SelectTrigger className="w-full" />
                        <SelectContent>
                          <SelectSection>
                            <SelectItem id="none">不导出字幕</SelectItem>
                            {subtitles.map((item) => (
                              <SelectItem
                                key={JSON.stringify([item.groupId, item.name])}
                                id={JSON.stringify([item.groupId, item.name])}
                              >
                                {item.name}
                              </SelectItem>
                            ))}
                          </SelectSection>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <Description>
                      跟随已完成媒体报告，按输出拆分。同步证据不足时单独显示导出失败。
                    </Description>
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
                    <Description>每行填写公共时间轴秒数：开始 --&gt; 结束 | 标题</Description>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </>
          )}
          <DisclosureGroup>
            <Disclosure id="timeline-advanced">
              <DisclosureTrigger>高级时间轴设置</DisclosureTrigger>
              <DisclosurePanel>
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
                      <Description>
                        {multi
                          ? '可填写 anchors（inputId、generation、epoch、source、presentation）、limits、tailDuration；input ID 见默认轨及字幕绑定。'
                          : '可填写 epochAnchors、limits、tailDuration；预算限制规划量，并非内存上限。'}{' '}
                        时间使用 ticks 字符串与 timescale。
                      </Description>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </DisclosurePanel>
            </Disclosure>
          </DisclosureGroup>
        </FieldGroup>
      )}
    </>
  );
}
