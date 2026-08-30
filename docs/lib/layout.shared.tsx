import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { uiTranslations } from 'fumadocs-ui/i18n';
import { i18n } from './i18n';
import { appName, gitConfig } from './shared';

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add({
    en: { displayName: 'English' },
    zh: { displayName: '简体中文' },
  });

const navText = {
  en: {
    guide: 'Guide',
    api: 'API',
    changelog: 'Changelog',
  },
  zh: {
    guide: '指南',
    api: 'API',
    changelog: '更新日志',
  },
} as const;

export function baseOptions(locale: string): BaseLayoutProps {
  const prefix = locale === 'en' ? '' : `/${locale}`;
  const t = navText[locale as keyof typeof navText] ?? navText.en;

  return {
    nav: {
      title: appName,
    },
    links: [
      {
        type: 'main',
        text: t.guide,
        url: `${prefix}/guide/getting-started`,
        active: 'nested-url',
      },
      {
        type: 'main',
        text: t.api,
        url: `${prefix}/api/hls-downloader`,
        active: 'nested-url',
      },
      {
        type: 'main',
        text: t.changelog,
        url: `${prefix}/changelog`,
        active: 'nested-url',
      },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
