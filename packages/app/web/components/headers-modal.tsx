'use client';

import { useEffect, useMemo } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
    reset({
      headers: defaultHeaderEntries.length ? defaultHeaderEntries : [{ key: '', value: '' }],
    });
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
    <Dialog isOpen={open} onOpenChange={onOpenChange} size="lg">
      <DialogHeader>
        <DialogTitle>自定义 Headers</DialogTitle>
      </DialogHeader>
      <Form {...form}>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-col gap-4">
          <DialogBody className="gap-3">
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
              {fields.map((field, index) => (
                <div key={field.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <Input
                    aria-label="Header 名称"
                    placeholder="Header 名称"
                    autoComplete="off"
                    {...register(`headers.${index}.key`)}
                  />
                  <Input
                    aria-label="Header 值"
                    placeholder="Header 值"
                    autoComplete="off"
                    {...register(`headers.${index}.value`)}
                  />
                  <Button
                    type="button"
                    intent="plain"
                    size="sq-sm"
                    onPress={() => remove(index)}
                    isDisabled={fields.length === 1}
                  >
                    <Trash2Icon />
                    <span className="sr-only">删除</span>
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              intent="outline"
              className="w-full"
              onPress={() => append({ key: '', value: '' })}
            >
              <PlusIcon />
              添加 Header
            </Button>
          </DialogBody>
          <DialogFooter>
            <Button type="button" intent="outline" onPress={onCancel}>
              取消
            </Button>
            <Button type="submit">确认</Button>
          </DialogFooter>
        </form>
      </Form>
    </Dialog>
  );
};
