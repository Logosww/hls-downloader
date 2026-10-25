import { createI18nMiddleware } from 'fumadocs-core/i18n/middleware';
import { i18n } from '@/lib/i18n';

export default createI18nMiddleware(i18n);

export const config = {
  // Keep API reference pages localized; serve brand assets without locale rewriting.
  matcher: ['/((?!api/search(?:/|$)|brand(?:/|$)|_next/static|_next/image|favicon.ico).*)'],
};
