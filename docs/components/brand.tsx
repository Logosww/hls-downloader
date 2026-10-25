import brand from '@/lib/brand.json';

export function BrandMark({
  size = 24,
  className,
  color = 'currentColor',
}: {
  size?: number;
  className?: string;
  color?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={brand.mark.viewBox}
      fill={color}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={brand.mark.path} />
    </svg>
  );
}

export function BrandLogo() {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap font-semibold tracking-tight">
      <BrandMark className="brand-mark shrink-0" />
      <span>{brand.name}</span>
    </span>
  );
}
