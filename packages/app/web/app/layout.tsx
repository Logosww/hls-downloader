import { Inter } from 'next/font/google';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import './global.css';
import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import brand from '@/lib/brand.generated.json';

const inter = Inter({
  display: 'swap',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: brand.name,
  applicationName: brand.name,
  description: 'Download whatever HLS videos you like easily',
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className={inter.className} suppressHydrationWarning>
      <body className="flex min-h-svh flex-col bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <Suspense
            fallback={
              <div className="flex w-screen h-screen justify-center items-center flex-col gap-4">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-3/8" />
              </div>
            }
          >
            {children}
          </Suspense>
          <footer className="shrink-0 px-4 pb-6 text-center text-xs text-muted-foreground">
            Powered by{' '}
            <a
              href="https://hls-downloader-docs.vercel.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center rounded-sm font-medium underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              @logosw/hls-downloader
            </a>
          </footer>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
