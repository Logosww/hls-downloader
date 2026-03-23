import { Fragment } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { CheckCircle, DownloadCloudIcon } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface IDownloadListItem {
  id: string;
  url: string;
  title: string;
  previewSrc: string;
  percentage: number;
  status: 'downloading' | 'paused' | 'completed' | 'failed' | 'saved';
  blobURL?: string;
}

interface IDownloadListItemProps {
  item: IDownloadListItem;
  onSave?: (id: string) => void;
}

interface IDownloadListProps {
  items: IDownloadListItem[];
  floatButton?: boolean;
  onSave?: (id: string) => void;
}

const DownloadListItem = ({ item, onSave }: IDownloadListItemProps) => {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        {item.previewSrc ? (
          <img className="rounded-md h-12 w-20 object-cover" src={item.previewSrc} alt="poster" />
        ) : (
          <div className="rounded-md h-12 w-20 bg-muted" />
        )}
        <div className="min-w-0">
          <div className="truncate text-sm">{item.title}</div>
          <div className="text-xs text-muted-foreground">
            {item.status === 'saved'
              ? '已保存'
              : item.status === 'completed'
                ? '已完成'
                : item.status === 'failed'
                  ? '失败'
                  : item.status === 'paused'
                    ? '已暂停'
                    : '下载中'}
          </div>
        </div>
      </div>
      {(item.status === 'downloading' || item.status === 'paused') && (
        <div className="w-40 flex items-center gap-2">
          <Progress value={item.percentage} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {Math.floor(item.percentage)}%
          </span>
        </div>
      )}
      {(item.status === 'saved' || (item.status === 'completed' && item.blobURL)) && (
        <Button
          size="sm"
          type="button"
          disabled={item.status === 'saved'}
          onClick={() => onSave?.(item.id)}
        >
          {item.status === 'saved' && <CheckCircle />}
          {item.status === 'saved' ? '已保存' : '保存'}
        </Button>
      )}
    </div>
  );
};

export const DownloadList = ({ items, floatButton, onSave }: IDownloadListProps) => {
  if (!floatButton)
    return (
      <Card>
        <CardHeader>
          <CardTitle>下载列表</CardTitle>
        </CardHeader>
        <CardContent className="w-2xl">
          <ScrollArea className="max-h-72">
            {items.length ? (
              items.map((item, index) => (
                <Fragment key={item.id}>
                  <DownloadListItem item={item} onSave={onSave} />
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
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <Button
                size="lg"
                variant="outline"
                className="cursor-pointer font-bold shadow-xl fixed z-10 bottom-16 right-16"
              >
                <DownloadCloudIcon />
                {items.length || ''}
              </Button>
            </TooltipTrigger>
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
                <DownloadListItem item={item} onSave={onSave} />
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
