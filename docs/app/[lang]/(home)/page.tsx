import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import { ArrowRight, Zap, Layers, FileCode2, Activity } from 'lucide-react';
import { appName, demoUrl, gitConfig } from '@/lib/shared';
import Link from 'next/link';
import { HeroFlow } from '@/components/hero-flow';
import { InstallCommand } from '@/components/install-command';
import SpecularButton from '@/components/react-bits/specular-button';
import SpotlightCard from '@/components/react-bits/spotlight-card';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.58.23 2.75.11 3.04.73.8 1.18 1.83 1.18 3.08 0 4.41-2.7 5.38-5.26 5.67.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.13 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

const content = {
  en: {
    title: appName,
    tagline: 'TypeScript HLS Download Library',
    headline: 'Every segment.',
    headlineAccent: 'One complete file.',
    platforms: 'Browser & Node.js',
    sourceCodecs: 'Source codecs preserved',
    typed: 'Fully typed API',
    foundation: 'BUILT FOR YOUR NEXT INTEGRATION',
    featuresHeading: 'The stream is complex. Your API doesn’t have to be.',
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
    ],
  },
  zh: {
    title: appName,
    tagline: 'TypeScript HLS 下载库',
    headline: '让每一段流，',
    headlineAccent: '完整抵达。',
    platforms: '浏览器 & Node.js',
    sourceCodecs: '默认保留源编码',
    typed: '完整类型支持',
    foundation: '为你的下一次集成而生',
    featuresHeading: '流媒体很复杂，接入可以很简单。',
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
    ],
  },
} as const;

export default async function HomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const t = content[lang as keyof typeof content] ?? content.en;
  const prefix = lang === 'en' ? '' : `/${lang}`;
  const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

  return (
    <div className="docs-home">
      <section className="docs-hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="hero-eyebrow">
            <span />
            {t.tagline}
          </p>
          <h1 id="hero-title">
            {t.headline}
            <br />
            <span>{t.headlineAccent}</span>
          </h1>
          <p className="hero-description">{t.subtitle}</p>

          <div className="hero-actions">
            <SpecularButton
              href={`${prefix}/guide/getting-started`}
              className="hero-button hero-button-primary"
              size="sm"
              radius={8}
              tint="var(--primary)"
              tintOpacity={1}
              textColor="var(--primary-foreground)"
              lineColor="#ffffff"
              baseColor="var(--primary)"
              intensity={1.4}
              idleIntensity={0.5}
              shineSize={14}
              shineFade={48}
            >
              {t.getStarted}
              <ArrowRight size={17} aria-hidden="true" />
            </SpecularButton>
            <SpecularButton
              href={demoUrl}
              target="_blank"
              rel="noreferrer"
              className="hero-button hero-button-secondary"
              size="sm"
              radius={8}
              tint="var(--card)"
              tintOpacity={0.9}
              textColor="var(--foreground)"
              lineColor="var(--primary)"
              baseColor="var(--border)"
              intensity={1.4}
              idleIntensity={0.5}
              shineSize={14}
              shineFade={48}
            >
              {t.liveDemo}
              <ArrowRight size={17} className="hero-external-arrow" aria-hidden="true" />
            </SpecularButton>
          </div>
          <InstallCommand lang={lang} />
          <div className="hero-secondary-links">
            <Link href={`${prefix}/api/hls-downloader`}>
              {t.apiReference}
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
            <span aria-hidden="true" />
            <a href={githubUrl} target="_blank" rel="noreferrer">
              <GitHubIcon className="size-4" />
              {t.github}
            </a>
          </div>
        </div>
        <HeroFlow lang={lang} />
      </section>

      <div className="hero-capabilities">
        <span>
          <Layers size={17} aria-hidden="true" />
          {t.platforms}
        </span>
        <span>
          <Zap size={17} aria-hidden="true" />
          {t.sourceCodecs}
        </span>
        <span>
          <FileCode2 size={17} aria-hidden="true" />
          {t.typed}
        </span>
      </div>

      <section className="home-features" aria-labelledby="features-title">
        <p className="features-eyebrow">{t.foundation}</p>
        <h2 id="features-title">{t.featuresHeading}</h2>
        <div className="home-features-grid">
          {t.features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <SpotlightCard
                key={feature.title}
                className="home-feature"
                spotlightColor="var(--primary)"
                intensity={0.12}
                spotlightSize={280}
                borderGlow={0.75}
                proximity={72}
                flare={false}
                style={
                  {
                    '--spotlight-card-surface': 'var(--card)',
                    '--spotlight-card-border': 'var(--border)',
                    '--spotlight-card-shadow': 'none',
                  } as CSSProperties
                }
              >
                <div className="feature-top">
                  <Icon size={21} aria-hidden="true" />
                  <span>0{index + 1}</span>
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.details}</p>
              </SpotlightCard>
            );
          })}
        </div>
      </section>
    </div>
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
