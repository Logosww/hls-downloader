import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { DocsDocument } from '@/components/docs-document';
import { siteUrl } from '@/lib/shared';
import brand from '@/lib/brand.json';
import './global.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: brand.name,
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/brand/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/brand/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/brand/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: brand.colors.paper },
    { media: '(prefers-color-scheme: dark)', color: brand.colors.night },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <DocsDocument className={inter.className}>{children}</DocsDocument>;
}
