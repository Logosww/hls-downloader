import { tv } from 'tailwind-variants';

export const labelStyles = tv({
  base: [
    "select-none text-base/6 text-foreground in-data-required:not-data-[slot='control-label']:after:ml-1.5 sm:text-sm/6",
    "in-data-required:not-data-[slot='control-label']:after:text-danger-subtle-foreground in-data-required:not-data-[slot='control-label']:after:content-['*']",
    'in-disabled:pointer-events-none in-disabled:opacity-50 group-disabled:opacity-50',
  ],
});

export const descriptionStyles = tv({
  base: 'block text-muted-foreground text-sm/6 in-disabled:opacity-50 group-disabled:opacity-50',
});

export const fieldErrorStyles = tv({
  base: 'block text-danger-subtle-foreground text-sm/6 in-disabled:opacity-50 group-disabled:opacity-50 forced-colors:text-[Mark]',
});

export const fieldStyles = tv({
  base: [
    'w-full',
    '[&>[data-slot=control]+[data-slot=control]]:mt-2',
    '[&>[data-slot=label]+[data-slot=control]]:mt-2',
    "[&>[data-slot=label]+[slot='description']]:mt-1",
    '[&>[slot=description]+[data-slot=control]]:mt-2',
    '[&>[data-slot=control]+[slot=description]]:mt-2',
    '[&>[data-slot=control]+[slot=errorMessage]]:mt-2',
    '*:data-[slot=label]:font-medium',
    'in-disabled:opacity-50 disabled:opacity-50',
  ],
});
