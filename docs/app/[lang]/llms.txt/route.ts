import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';

export const revalidate = false;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ lang: string }> },
) {
  const { lang } = await params;

  return new Response(llms(source).index(lang), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export function generateStaticParams() {
  return [{ lang: 'en' }, { lang: 'zh' }];
}
