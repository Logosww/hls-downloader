import brand from '@/lib/brand.generated.json';

export function BrandMark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={80}
      height={80}
      viewBox={brand.mark.viewBox}
      fill="currentColor"
      className="text-primary shrink-0"
      aria-hidden="true"
      focusable="false"
    >
      <path d={brand.mark.path} />
    </svg>
  );
}
