'use client';

import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { i18nProvider } from 'fumadocs-ui/i18n';
import { Analytics } from '@vercel/analytics/next';
import { i18n } from '@/lib/i18n';
import { translations } from '@/lib/layout.shared';

// Keep the theme provider above [lang] so its initialization script is only
// hydrated once, rather than mounted again during client-side locale changes.
export function DocsDocument({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  const { lang = i18n.defaultLanguage } = useParams<{ lang?: string }>();

  return (
    <html lang={lang} className={className} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={i18nProvider(translations, lang)}>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  );
}
