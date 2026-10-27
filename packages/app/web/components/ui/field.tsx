'use client';

import {
  FieldError as FieldErrorPrimitive,
  type FieldErrorProps,
} from 'react-aria-components/FieldError';
import {
  LabelContext,
  Label as LabelPrimitive,
  type LabelProps,
} from 'react-aria-components/Label';
import { Text, type TextProps } from 'react-aria-components/Text';
import { cn } from 'cn';
import { labelStyles, descriptionStyles, fieldErrorStyles } from '@/lib/field-styles';
import { cx } from '@/lib/primitive';

export function Label({ className, htmlFor, slot, ...props }: LabelProps) {
  const label = (
    <LabelPrimitive
      data-slot="label"
      htmlFor={htmlFor}
      slot={slot}
      {...props}
      className={labelStyles({ className })}
    />
  );

  if (htmlFor && slot === undefined) {
    return <LabelContext.Provider value={null}>{label}</LabelContext.Provider>;
  }

  return label;
}

export function Description({ className, ...props }: TextProps) {
  return <Text {...props} slot="description" className={descriptionStyles({ className })} />;
}

export function Fieldset({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return (
    <fieldset
      className={cn('*:data-[slot=text]:mt-1 [&>*+[data-slot=control]]:mt-6', className)}
      {...props}
    />
  );
}

export function FieldGroup({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="control" className={cn('flex flex-col gap-5', className)} {...props} />;
}

export function FieldError({ className, ...props }: FieldErrorProps) {
  return <FieldErrorPrimitive {...props} className={cx(fieldErrorStyles(), className)} />;
}

export function Legend({ className, ...props }: React.ComponentProps<'legend'>) {
  return (
    <legend
      data-slot="legend"
      {...props}
      className={cn('font-semibold text-base/6 data-disabled:opacity-50', className)}
    />
  );
}
