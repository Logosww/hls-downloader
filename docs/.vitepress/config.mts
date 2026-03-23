import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'HLS Downloader',
  description:
    'A TypeScript library for parsing HLS (.m3u8) playlists and downloading/merging streams into playable files.',

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started' },
          { text: 'API', link: '/api/hls-downloader' },
        ],
        sidebar: {
          '/guide/': [
            {
              text: 'Guide',
              items: [
                { text: 'Getting Started', link: '/guide/getting-started' },
                { text: 'Adapters', link: '/guide/adapters' },
                { text: 'Events', link: '/guide/events' },
              ],
            },
          ],
          '/api/': [
            {
              text: 'API Reference',
              items: [
                { text: 'HlsDownloader', link: '/api/hls-downloader' },
                { text: 'Types', link: '/api/types' },
                { text: 'Adapters', link: '/api/adapters' },
              ],
            },
          ],
        },
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      description: '用于解析 HLS（.m3u8）并下载、合并为可播放文件的 TypeScript 库。',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/getting-started' },
          { text: 'API', link: '/zh/api/hls-downloader' },
        ],
        sidebar: {
          '/zh/guide/': [
            {
              text: '指南',
              items: [
                {
                  text: '快速开始',
                  link: '/zh/guide/getting-started',
                },
                { text: '适配器', link: '/zh/guide/adapters' },
                { text: '事件', link: '/zh/guide/events' },
              ],
            },
          ],
          '/zh/api/': [
            {
              text: 'API 参考',
              items: [
                {
                  text: 'HlsDownloader',
                  link: '/zh/api/hls-downloader',
                },
                { text: '类型定义', link: '/zh/api/types' },
                { text: '适配器', link: '/zh/api/adapters' },
              ],
            },
          ],
        },
      },
    },
  },

  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/Logosww/hls-downloader',
      },
    ],
    footer: {
      message: 'Released under the MIT License.',
    },
  },
});
