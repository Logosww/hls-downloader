import type { Metadata } from 'next';
import { ArrowRight, Zap, Layers, FileCode2, Activity, Boxes } from 'lucide-react';
import { appName, demoUrl, gitConfig } from '@/lib/shared';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.58.23 2.75.11 3.04.73.8 1.18 1.83 1.18 3.08 0 4.41-2.7 5.38-5.26 5.67.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.13 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

const content = {
  en: {
    title: 'HLS Downloader',
    tagline: 'TypeScript HLS Download Library',
    subtitle:
      'Parse HLS (.m3u8) playlists and download/merge streams into playable files. Default downloads transmux while keeping source codecs; opt into re-encoding with transcode.',
    getStarted: 'Get Started',
    liveDemo: 'Live Demo',
    apiReference: 'API Reference',
    github: 'GitHub',
    features: [
      {
        icon: Zap,
        title: 'Performant · Lightweight',
        details:
          'Ordinary downloads transmux/remux while keeping source codecs. BrowserAdapter uses hls-transmux WebAssembly; NodeAdapter uses its native Rust path.',
      },
      {
        icon: Layers,
        title: 'Dual Adapters',
        details:
          'BrowserAdapter for browsers and NodeAdapter (Rust N-API) for Node.js — one unified API.',
      },
      {
        icon: FileCode2,
        title: 'TypeScript First',
        details:
          'Written in TypeScript with full type definitions. Enjoy type-safe APIs and excellent IDE support.',
      },
      {
        icon: Activity,
        title: 'Event-Driven Progress',
        details:
          'Rich event system for tracking download progress, segment stitching, and error handling in real time.',
      },
      {
        icon: Boxes,
        title: 'Monorepo Architecture',
        details:
          'Modular packages — install the umbrella package or pick only what you need with scoped imports.',
      },
    ],
  },
  zh: {
    title: 'HLS Downloader',
    tagline: 'TypeScript HLS 下载库',
    subtitle:
      '解析 HLS（.m3u8）播放列表，下载并合并为可播放文件。默认保留源编码并 transmux；需要重编码时再通过 transcode 显式启用。',
    getStarted: '快速开始',
    liveDemo: '在线演示',
    apiReference: 'API 参考',
    github: 'GitHub',
    features: [
      {
        icon: Zap,
        title: '高性能 · 轻量',
        details:
          '普通下载经 transmux/remux 合并并保留源编码。BrowserAdapter 使用 hls-transmux WebAssembly；NodeAdapter 使用原生 Rust 路径。',
      },
      {
        icon: Layers,
        title: '双适配器',
        details:
          '浏览器使用 BrowserAdapter，Node.js 使用 NodeAdapter（Rust N-API）— 统一的 API 接口。',
      },
      {
        icon: FileCode2,
        title: 'TypeScript 优先',
        details: '使用 TypeScript 编写，提供完整的类型定义。享受类型安全的 API 和出色的 IDE 支持。',
      },
      {
        icon: Activity,
        title: '事件驱动的进度追踪',
        details: '丰富的事件系统，实时追踪下载进度、分片合并和错误处理。',
      },
      {
        icon: Boxes,
        title: 'Monorepo 架构',
        details: '模块化的包结构 — 可安装聚合包，也可按需引入作用域子包。',
      },
    ],
  },
} as const;

export default async function HomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const t = content[lang as keyof typeof content] ?? content.en;
  const prefix = lang === 'en' ? '' : `/${lang}`;
  const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-24 text-center">
      <div className="mx-auto max-w-3xl">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          {t.tagline}
        </p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight sm:text-6xl">{t.title}</h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">{t.subtitle}</p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <a
            href={`${prefix}/guide/getting-started`}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
          >
            {t.getStarted}
            <ArrowRight className="size-4" />
          </a>
          <a
            href={demoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {t.liveDemo}
          </a>
          <a
            href={`${prefix}/api/hls-downloader`}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {t.apiReference}
          </a>
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <GitHubIcon className="size-4" />
            {t.github}
          </a>
        </div>
      </div>

      <div className="mx-auto mt-20 grid w-full max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {t.features.map((feature) => {
          const Icon = feature.icon;
          return (
            <div
              key={feature.title}
              className="rounded-lg border border-border bg-card p-6 text-left shadow-sm transition-colors hover:bg-accent/50"
            >
              <div className="flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon className="size-5" />
              </div>
              <h3 className="mt-4 font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{feature.details}</p>
            </div>
          );
        })}
      </div>
    </main>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  const t = content[lang as keyof typeof content] ?? content.en;

  return {
    title: `${appName} — ${t.tagline}`,
    description: t.subtitle,
  };
}
