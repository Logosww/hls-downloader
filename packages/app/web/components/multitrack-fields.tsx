import { useWatch, type UseFormReturn } from 'react-hook-form';
import type { Playlist, Rendition } from '@hls-downloader/shared';
import type { ConfirmFormValues } from './confirm-modal';
import { availableTracks } from '@/lib/multitrack-options';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { FieldGroup, FieldDescription } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Input } from '@/components/ui/input';

export function MultiTrackFields({
  form,
  playlist,
  renditions,
}: {
  form: UseFormReturn<ConfirmFormValues>;
  playlist?: Playlist[];
  renditions?: Rendition[];
}) {
  const [mode, quality, embedded, audioKeys, subtitleKeys] = useWatch({
    control: form.control,
    name: ['trackMode', 'quality', 'embeddedAudio', 'audioTracks', 'embeddedSubtitles'],
  });
  const tracks = availableTracks(
    playlist?.find((v) => v.name === quality),
    renditions,
  );
  const audio = tracks.filter((t) => t.rendition.type === 'audio'),
    subtitles = tracks.filter((t) => t.rendition.type === 'subtitles');
  const selectedAudio = audio.filter((t) => audioKeys?.includes(t.value)),
    selectedSubtitles = subtitles.filter((t) => subtitleKeys?.includes(t.value));
  const mediaItems = [
    { value: 'primary', label: '主媒体（primary）' },
    ...selectedAudio.map((t) => ({ value: t.id, label: `${t.rendition.name}（${t.id}）` })),
  ];
  return (
    <FieldGroup>
      <FormField
        name="trackMode"
        control={form.control}
        render={({ field }) => (
          <FormItem>
            <FormLabel>轨道模式</FormLabel>
            <FormControl>
              <ToggleGroup
                value={[field.value ?? 'single']}
                onValueChange={(v) => {
                  if (!v[0]) return;
                  field.onChange(v[0]);
                  form.setValue('timelineAdvanced', '');
                  if (v[0] === 'multi') {
                    form.setValue('transcodePreset', 'none');
                  }
                }}
                aria-label="轨道模式"
              >
                <ToggleGroupItem value="single">单音轨</ToggleGroupItem>
                <ToggleGroupItem value="multi">多轨下载</ToggleGroupItem>
              </ToggleGroup>
            </FormControl>
          </FormItem>
        )}
      />
      {mode === 'multi' && (
        <FieldGroup>
          <FieldDescription>
            只下载已结束的媒体及字幕。所选轨道写入同一
            MP4；仅保证容器输出，播放器对多音轨和内嵌字幕的支持可能不同。字幕支持纯文本及有限设置。
          </FieldDescription>
          <FormField
            name="embeddedAudio"
            control={form.control}
            render={({ field }) => (
              <FormItem>
                <FormLabel>主媒体内嵌音频</FormLabel>
                <FormControl>
                  <ToggleGroup
                    value={[field.value ?? 'keep']}
                    onValueChange={(v) => {
                      if (!v[0]) return;
                      field.onChange(v[0]);
                      if (v[0] === 'exclude' && form.getValues('defaultAudio') === 'primary')
                        form.setValue('defaultAudio', 'auto');
                    }}
                    aria-label="主媒体内嵌音频"
                  >
                    <ToggleGroupItem value="keep">保留</ToggleGroupItem>
                    <ToggleGroupItem value="exclude">排除</ToggleGroupItem>
                  </ToggleGroup>
                </FormControl>
              </FormItem>
            )}
          />
          {(['audioTracks', 'embeddedSubtitles'] as const).map((name) => {
            const options = (name === 'audioTracks' ? audio : subtitles).map((t) => ({
              value: t.value,
              label: `${t.rendition.name}${t.rendition.language ? ` · ${t.rendition.language}` : ''}`,
            }));
            return (
              <FormField
                key={name}
                name={name}
                control={form.control}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {name === 'audioTracks' ? '外部音轨（多选）' : '内嵌字幕（多选）'}
                    </FormLabel>
                    <FormControl>
                      <Select
                        multiple
                        items={options}
                        value={field.value ?? []}
                        disabled={!options.length}
                        onValueChange={(value) => {
                          field.onChange(value);
                          form.setValue(
                            name === 'audioTracks' ? 'defaultAudio' : 'defaultSubtitle',
                            name === 'audioTracks' ? 'auto' : 'none',
                          );
                          if (name === 'audioTracks')
                            form.setValue(
                              'subtitleBindings',
                              Object.fromEntries(selectedSubtitles.map((t) => [t.id, 'primary'])),
                            );
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue>
                            {(value: string[]) =>
                              value.length
                                ? `${value.length} 条已选：${options
                                    .filter((t) => value.includes(t.value))
                                    .map((t) => t.label)
                                    .join('、')}`
                                : options.length
                                  ? '不选入其他轨道'
                                  : '当前视频质量无可选轨道'
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {options.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            );
          })}
          {(['defaultAudio', 'defaultSubtitle'] as const).map((name) => {
            const items =
              name === 'defaultAudio'
                ? [
                    { value: 'auto', label: '自动：第一条音轨' },
                    ...(embedded !== 'exclude'
                      ? [{ value: 'primary', label: '主媒体内嵌音频' }]
                      : []),
                    ...selectedAudio.map((t) => ({ value: t.id, label: t.rendition.name })),
                  ]
                : [
                    { value: 'none', label: '不设默认字幕' },
                    ...selectedSubtitles.map((t) => ({ value: t.id, label: t.rendition.name })),
                  ];
            return (
              <FormField
                key={name}
                name={name}
                control={form.control}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{name === 'defaultAudio' ? '默认音轨' : '默认字幕'}</FormLabel>
                    <FormControl>
                      <Select
                        items={items}
                        value={field.value ?? items[0]!.value}
                        onValueChange={field.onChange}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {items.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FormControl>
                  </FormItem>
                )}
              />
            );
          })}
          {selectedSubtitles.map((track) => (
            <FormField
              key={track.id}
              name={`subtitleBindings.${track.id}`}
              defaultValue="primary"
              control={form.control}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{track.rendition.name} 字幕时钟绑定</FormLabel>
                  <FormControl>
                    <Select
                      items={mediaItems}
                      value={field.value ?? 'primary'}
                      onValueChange={field.onChange}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {mediaItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FieldDescription>绑定 X-TIMESTAMP-MAP 所引用的媒体源时钟。</FieldDescription>
                </FormItem>
              )}
            />
          ))}
          <FormField
            name="memoryLimitMiB"
            control={form.control}
            render={({ field }) => (
              <FormItem>
                <FormLabel>内存输出上限（MiB）</FormLabel>
                <FormControl>
                  <Input {...field} type="number" min={1} max={4096} />
                </FormControl>
                <FieldDescription>
                  普通下载及分割输出共享此上限；大文件可使用直存。超限会停止任务并保留已完成输出。
                </FieldDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </FieldGroup>
      )}
    </FieldGroup>
  );
}
