import { getPageImageUrl, source } from '@/lib/source';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { generate as DefaultImage } from 'fumadocs-ui/og';
import { appName } from '@/lib/shared';

export const revalidate = false;

// Noto Sans SC (static TTF) so CJK titles/descriptions render without tofu.
// `next/og` (satori) does not support WOFF2, hence the TTF variant. Fallback to
// the default font if the fetch fails.
const CJK_FONT_URLS = {
  400: 'https://fonts.gstatic.com/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYw.ttf',
  700: 'https://fonts.gstatic.com/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYw.ttf',
} as const;

let fontPromise:
  | Promise<
      | {
          name: string;
          data: ArrayBuffer;
          weight: 400 | 700;
          style: 'normal';
        }[]
      | null
    >
  | undefined;

function loadCJKFonts() {
  if (!fontPromise) {
    fontPromise = Promise.all(
      (Object.entries(CJK_FONT_URLS) as [('400' | '700'), string][]).map(
        async ([weight, url]) => {
          const data = await fetch(url).then((res) => res.arrayBuffer());

          return {
            name: 'Noto Sans SC',
            data,
            weight: Number(weight) as 400 | 700,
            style: 'normal' as const,
          };
        },
      ),
    ).catch(() => null);
  }

  return fontPromise;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ lang: string; slug: string[] }> },
) {
  const { lang, slug } = await params;
  const page = source.getPage(slug.slice(0, -1), lang);
  if (!page) notFound();

  const fonts = await loadCJKFonts();

  return new ImageResponse(
    <DefaultImage
      title={page.data.title}
      description={page.data.description}
      site={appName}
    />,
    {
      width: 1200,
      height: 630,
      fonts: fonts ?? [],
    },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImageUrl(page).segments,
  }));
}
