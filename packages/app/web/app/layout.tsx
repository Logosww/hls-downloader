import { DM_Sans } from 'next/font/google';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import './global.css';
import { Metadata } from 'next';

const DmSans = DM_Sans({
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'HLS Downloader',
  description: 'Download whatever HLS videos you like easily',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className={DmSans.className} suppressHydrationWarning>
      <body className="bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
