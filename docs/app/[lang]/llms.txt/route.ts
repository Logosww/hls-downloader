import { source } from '@/lib/source';
import { i18n } from '@/lib/i18n';
import { siteUrl } from '@/lib/shared';
import { llms } from 'fumadocs-core/source';

export const revalidate = false;

export async function GET(_req: Request, { params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!i18n.languages.some((language) => language === lang)) {
    return new Response('Not found', { status: 404 });
  }

  const prefix = lang === i18n.defaultLanguage ? '' : `/${lang}`;
  const index = llms(source, {
    renderUrl: (node) => new URL(node.url, siteUrl).href,
  }).index(lang);
  const fullUrl = new URL(`${prefix}/llms-full.txt`, siteUrl).href;
  const extra = lang === 'zh'
    ? `## 完整文档\n\n- [完整文档（Markdown）](${fullUrl}): 在一次请求中读取该语言的所有文档。`
    : `## Full documentation\n\n- [Full documentation (Markdown)](${fullUrl}): Read all documentation in this language in one request.`;

  return new Response(`${index}\n\n${extra}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}
