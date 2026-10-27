import { MultiTrackSummary } from './multitrack-summary';
import { formatMediaTime } from '@/lib/timeline-options';
import { Fragment } from 'react';
import { Popover, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { CheckCircle, DownloadCloudIcon, Trash2Icon, XIcon } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { ProgressBar, ProgressBarTrack } from '@/components/ui/progress-bar';
import { Dialog as AriaDialog } from 'react-aria-components/Dialog';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { DownloadTask } from '@/hooks/use-download-manager';

export type IDownloadListItem = DownloadTask;

interface IDownloadListItemProps {
  item: IDownloadListItem;
  onSave?: (id: string, index?: string) => void;
  onSaveArtifact?: (id: string, filename?: string) => void;
  onCancel?: (id: string) => void;
  onRemove?: (id: string) => void;
}

interface IDownloadListProps {
  items: IDownloadListItem[];
  floatButton?: boolean;
  onSave?: (id: string, index?: string) => void;
  onSaveArtifact?: (id: string, filename?: string) => void;
  onCancel?: (id: string) => void;
  onRemove?: (id: string) => void;
}

const statusLabels: Record<DownloadTask['status'], string> = {
  queued: '排队中',
  downloading: '下载中',
  saving: '正在完成保存',
  completed: '待保存',
  failed: '失败',
  saved: '已保存',
  cancelled: '已取消',
};

const DownloadProgress = ({
  item,
  onCancel,
}: Pick<IDownloadListItemProps, 'item' | 'onCancel'>) => (
  <div className="w-full sm:w-44 shrink-0 flex items-center gap-2">
    <ProgressBar
      aria-label={`${item.title} 下载进度`}
      className="min-w-0 flex-1"
      value={item.percentage}
      isIndeterminate={!!item.multiTrack}
    >
      <ProgressBarTrack className="min-w-0" />
    </ProgressBar>
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {item.multiTrack
        ? `${(Number(item.multiTrackBytes ?? '0') / 1048576).toFixed(1)} MiB`
        : `${Math.floor(item.percentage)}%`}
    </span>
    <Button
      size="sq-sm"
      intent="danger"
      type="button"
      aria-label={`取消 ${item.title}`}
      onPress={() => onCancel?.(item.id)}
    >
      <XIcon data-icon="icon" />
    </Button>
  </div>
);

const DownloadActions = ({
  item,
  onSave,
  onRemove,
}: Pick<IDownloadListItemProps, 'item' | 'onSave' | 'onRemove'>) => {
  const canSave = item.status === 'saved' || (item.status === 'completed' && item.blobURL);
  return (
    <div className="flex items-center gap-2">
      {canSave ? (
        <Button
          size="sm"
          type="button"
          isDisabled={item.status === 'saved'}
          onPress={() => onSave?.(item.id)}
        >
          {item.status === 'saved' ? <CheckCircle data-icon="inline-start" /> : null}
          {item.status === 'saved' ? '已保存' : '保存'}
        </Button>
      ) : null}
      <Button
        size="sq-sm"
        intent="plain"
        type="button"
        aria-label={`删除 ${item.title}`}
        onPress={() => onRemove?.(item.id)}
      >
        <Trash2Icon data-icon="icon" />
      </Button>
    </div>
  );
};

const DownloadOutputRow = ({
  item,
  output,
  onSave,
}: {
  item: DownloadTask;
  output: NonNullable<DownloadTask['outputs']>[number];
  onSave?: IDownloadListItemProps['onSave'];
}) => {
  const descriptor = item.timelineMap?.outputs.find((value) => value.index === output.index);
  return (
    <div key={output.index} className="flex items-center justify-between gap-2 text-sm">
      <div className="min-w-0">
        <div className="truncate">{output.title}</div>
        {descriptor && (
          <p className="text-xs text-muted-foreground">
            {formatMediaTime(descriptor.actualRange.start)} –{' '}
            {formatMediaTime(descriptor.actualRange.end)} ·{' '}
            {descriptor.reason === 'ConfigurationChanged'
              ? '配置变化'
              : descriptor.reason === 'Gap'
                ? '缺口拆分'
                : '首个输出'}
          </p>
        )}
      </div>
      <Button
        size="sm"
        isDisabled={output.saved || !output.blobURL}
        onPress={() => onSave?.(item.id, output.index)}
      >
        {output.saved ? '已保存' : '保存文件'}
      </Button>
    </div>
  );
};

function taskStatusText(item: DownloadTask): string {
  if (item.timeline && item.status === 'downloading' && item.percentage <= 1)
    return '扫描并验证时间轴';
  if (item.outputMode === 'file' && item.status === 'downloading') return '下载并写入中';
  return statusLabels[item.status];
}

const DownloadListItem = ({
  item,
  onSave,
  onSaveArtifact,
  onCancel,
  onRemove,
}: IDownloadListItemProps) => {
  const isPending =
    item.status === 'queued' || item.status === 'downloading' || item.status === 'saving';
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <div className="flex w-full min-w-0 flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-1 items-center gap-2 min-w-0">
          {item.previewSrc ? (
            <img
              className="rounded-md h-12 w-20 shrink-0 object-cover"
              src={item.previewSrc}
              alt="poster"
            />
          ) : (
            <div className="rounded-md h-12 w-20 shrink-0 bg-muted" />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm">{item.title}</div>
            <div className="text-xs text-muted-foreground" role="status">
              {item.multiTrack ? '多轨下载 · ' : ''}
              {item.outputMode === 'file' ? '大文件直存 · ' : '普通下载 · '}
              {taskStatusText(item)}
            </div>
            {item.error ? (
              <p className="text-xs text-destructive" role="alert">
                {item.error}
              </p>
            ) : null}
          </div>
        </div>
        {isPending ? (
          <DownloadProgress item={item} onCancel={onCancel} />
        ) : (
          <DownloadActions item={item} onSave={onSave} onRemove={onRemove} />
        )}
      </div>
      {item.multiTrackReport && (
        <MultiTrackSummary
          report={item.multiTrackReport}
          onSave={() => onSaveArtifact?.(item.id)}
        />
      )}
      {item.timelineMap?.outputs.length ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            实际范围：{formatMediaTime(item.timelineMap.outputs[0]!.actualRange.start)} –{' '}
            {formatMediaTime(item.timelineMap.outputs.at(-1)!.actualRange.end)}
          </span>
          {item.timeline?.range && (
            <span>
              请求范围：{formatMediaTime(item.timeline?.range.start)} –{' '}
              {formatMediaTime(item.timeline?.range.end)}
            </span>
          )}
          <Button intent="outline" size="sm" onPress={() => onSaveArtifact?.(item.id)}>
            保存时间轴报告
          </Button>
        </div>
      ) : null}
      {item.outputs?.map((output) => (
        <DownloadOutputRow key={output.index} item={item} output={output} onSave={onSave} />
      ))}
      {item.sidecars?.map((sidecar) => (
        <div key={sidecar.filename} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{sidecar.filename}</span>
          <Button
            intent="outline"
            size="sm"
            onPress={() => onSaveArtifact?.(item.id, sidecar.filename)}
          >
            保存 WebVTT
          </Button>
        </div>
      ))}
      {item.sidecarError && (
        <p role="alert" className="text-xs text-destructive">
          {item.sidecarError}；媒体输出已保留。
        </p>
      )}
    </div>
  );
};

export const DownloadList = ({
  items,
  floatButton,
  onSave,
  onSaveArtifact,
  onCancel,
  onRemove,
}: IDownloadListProps) => {
  if (!floatButton)
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>下载列表</CardTitle>
        </CardHeader>
        <CardContent className="w-full">
          <ScrollArea className="max-h-72 [&>[data-slot=scroll-area-viewport]]:max-h-72">
            {items.length ? (
              items.map((item, index) => (
                <Fragment key={item.id}>
                  <DownloadListItem
                    item={item}
                    onSave={onSave}
                    onSaveArtifact={onSaveArtifact}
                    onCancel={onCancel}
                    onRemove={onRemove}
                  />
                  {index !== items.length - 1 && <Separator className="my-2" />}
                </Fragment>
              ))
            ) : (
              <div className="text-sm text-center text-muted-foreground">暂无下载任务</div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    );

  return (
    <PopoverTrigger>
      <TooltipTrigger delay={300}>
        <Button size="lg" intent="outline" aria-label="下载列表" className="fixed bottom-8 right-6">
          <DownloadCloudIcon data-icon="icon" />
          {items.length || ''}
        </Button>
        <Tooltip>下载列表</Tooltip>
      </TooltipTrigger>
      <Popover className="w-150 max-w-[calc(100vw-2rem)] select-none" placement="top end">
        <AriaDialog aria-label="下载列表" className="flex flex-col gap-4 p-4 outline-hidden">
          <h4 className="font-medium leading-none">下载列表</h4>
          <ScrollArea className="max-h-72 [&>[data-slot=scroll-area-viewport]]:max-h-72">
            {items.length ? (
              items.map((item, index) => (
                <Fragment key={item.id}>
                  <DownloadListItem
                    item={item}
                    onSave={onSave}
                    onSaveArtifact={onSaveArtifact}
                    onCancel={onCancel}
                    onRemove={onRemove}
                  />
                  {index !== items.length - 1 && <Separator className="my-2" />}
                </Fragment>
              ))
            ) : (
              <div className="py-4 text-sm text-center text-muted-foreground">暂无下载任务</div>
            )}
          </ScrollArea>
        </AriaDialog>
      </Popover>
    </PopoverTrigger>
  );
};

export default DownloadList;
