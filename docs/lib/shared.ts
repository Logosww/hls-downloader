export const appName = 'HLS Downloader';

// Docs are served from the site root (`/guide`, `/api`, `/changelog`) to
// preserve the previous VitePress URL structure. The default locale (`en`)
// is prefix-less; other locales are served under `/{locale}` (e.g. `/zh`).
export const docsRoute = '';

export const gitConfig = {
  user: 'Logosww',
  repo: 'hls-downloader',
  branch: 'main',
};

export const demoUrl = 'https://hls-downloader-web-app.vercel.app';

// Absolute base URL for metadata (Open Graph, canonical).
// On Vercel this auto-resolves from the deployment URL; override with
// `NEXT_PUBLIC_SITE_URL` for a custom domain.
const vercelProdUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (vercelProdUrl ? `https://${vercelProdUrl}` : undefined) ??
  'https://hls-downloader.vercel.app';
