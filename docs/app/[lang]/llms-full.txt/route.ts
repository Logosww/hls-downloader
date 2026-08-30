import { getLLMText, source } from '@/lib/source';

export const revalidate = false;

export async function GET(_req: Request, { params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const scanned = await Promise.all(source.getPages(lang).map(getLLMText));

  return new Response(scanned.join('\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export function generateStaticParams() {
  return [{ lang: 'en' }, { lang: 'zh' }];
}
