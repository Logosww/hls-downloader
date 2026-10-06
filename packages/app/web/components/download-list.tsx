import { formatMediaTime } from '@/lib/timeline-options';
import { Fragment } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { CheckCircle, DownloadCloudIcon, Trash2Icon, XIcon } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
    <Progress className="min-w-0 flex-1" value={item.percentage} />
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {Math.floor(item.percentage)}%
    </span>
    <Button
      size="icon-sm"
      variant="destructive"
      type="button"
      aria-label={`取消 ${item.title}`}
      onClick={() => onCancel?.(item.id)}
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
          disabled={item.status === 'saved'}
          onClick={() => onSave?.(item.id)}
        >
          {item.status === 'saved' ? <CheckCircle data-icon="inline-start" /> : null}
          {item.status === 'saved' ? '已保存' : '保存'}
        </Button>
      ) : null}
      <Button
        size="icon-sm"
        variant="ghost"
        type="button"
        aria-label={`删除 ${item.title}`}
        onClick={() => onRemove?.(item.id)}
      >
        <Trash2Icon data-icon="icon" />
      </Button>
    </div>
  );
};

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
              {item.outputMode === 'file' ? '大文件直存 · ' : '普通下载 · '}
              {item.timeline && item.status === 'downloading' && item.percentage <= 1
                ? '扫描并验证时间轴'
                : item.outputMode === 'file' && item.status === 'downloading'
                  ? '下载并写入中'
                  : statusLabels[item.status]}
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
      {item.timelineReport && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            实际范围：{formatMediaTime(item.timelineReport.actual.start)} –{' '}
            {formatMediaTime(item.timelineReport.actual.end)}
          </span>
          {item.timelineReport.requested && (
            <span>
              请求范围：{formatMediaTime(item.timelineReport.requested.start)} –{' '}
              {formatMediaTime(item.timelineReport.requested.end)}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => onSaveArtifact?.(item.id)}>
            保存时间轴报告
          </Button>
        </div>
      )}
      {item.outputs?.map((output) => {
        const descriptor = item.timelineReport?.outputs.find(
          (value) => value.index === output.index,
        );
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
              disabled={output.saved || !output.blobURL}
              onClick={() => onSave?.(item.id, output.index)}
            >
              {output.saved ? '已保存' : '保存文件'}
            </Button>
          </div>
        );
      })}
      {item.sidecars?.map((sidecar) => (
        <div key={sidecar.filename} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{sidecar.filename}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSaveArtifact?.(item.id, sidecar.filename)}
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
          <ScrollArea className="max-h-72">
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
    <Popover>
      <TooltipProvider>
        <Tooltip>
          <PopoverTrigger
            render={
              <TooltipTrigger
                render={
                  <Button
                    size="lg"
                    variant="outline"
                    className="cursor-pointer font-bold shadow-xl fixed z-10 bottom-16 right-16"
                  />
                }
              />
            }
          >
            <DownloadCloudIcon data-icon="icon" />
            {items.length || ''}
          </PopoverTrigger>
          <TooltipContent>下载列表</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent className="w-150 select-none">
        <h4 className="font-medium leading-none">下载列表</h4>
        <ScrollArea className="max-h-72">
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
      </PopoverContent>
    </Popover>
  );
};

export default DownloadList;
