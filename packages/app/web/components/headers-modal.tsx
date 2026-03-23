'use client';

import { useEffect, useMemo } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form } from '@/components/ui/form';
import { Input } from '@/components/ui/input';

interface IHeadersModalProps {
  open?: boolean;
  defaultHeaders?: Record<string, string>;
  onOpenChange?: (open: boolean) => void;
  onConfirm?: (headers: Record<string, string>) => void;
}

export const HeadersModal = ({
  open,
  defaultHeaders,
  onConfirm,
  onOpenChange,
}: IHeadersModalProps) => {
  const defaultHeaderEntries = useMemo(
    () =>
      Object.entries(defaultHeaders ?? {}).map(([key, value]) => ({
        key,
        value,
      })),
    [defaultHeaders],
  );

  const form = useForm<{
    headers: {
      key: string;
      value: string;
    }[];
  }>({
    defaultValues: {
      headers: defaultHeaderEntries.length ? defaultHeaderEntries : [{ key: '', value: '' }],
    },
  });
  const { control, register, handleSubmit, reset } = form;
  const { fields, append, remove } = useFieldArray({
    control,
    name: 'headers',
  });

  useEffect(() => {
    if (!open) return;
    reset({ headers: defaultHeaderEntries.length ? defaultHeaderEntries : [{ key: '', value: '' }] });
  }, [defaultHeaderEntries, open, reset]);

  const onSubmit = handleSubmit((values) => {
    const headers = values.headers.reduce<Record<string, string>>((result, item) => {
      const key = item.key.trim();
      if (!key) return result;
      result[key] = item.value;
      return result;
    }, {});
    onConfirm?.(headers);
    onOpenChange?.(false);
  });

  const onCancel = () => {
    onOpenChange?.(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>自定义 Headers</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
              {fields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <Input
                    placeholder="Header 名称"
                    autoComplete="off"
                    {...register(`headers.${index}.key`)}
                  />
                  <Input
                    placeholder="Header 值"
                    autoComplete="off"
                    {...register(`headers.${index}.value`)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(index)}
                    disabled={fields.length === 1}
                  >
                    <Trash2Icon />
                    <span className="sr-only">删除</span>
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => append({ key: '', value: '' })}
            >
              <PlusIcon />
              添加 Header
            </Button>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onCancel}>
                取消
              </Button>
              <Button type="submit">确认</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
