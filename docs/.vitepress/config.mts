import { defineConfig } from 'vitepress';

export default defineConfig({
  base: process.env.VITEPRESS_BASE || '/',
  head: [
    [
      'script',
      {
        defer: '',
        src: 'https://static.cloudflareinsights.com/beacon.min.js',
        'data-cf-beacon': JSON.stringify({
          token: '65001d3d57b44a6498fcb9600587c5b7',
        }),
      },
    ],
  ],
  title: 'HLS Downloader',
  description:
    'Parse HLS (.m3u8) playlists and download/merge streams into playable files. Default downloads transmux while keeping source codecs; opt into re-encoding with transcode.',

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/getting-started' },
          { text: 'API', link: '/api/hls-downloader' },
          { text: 'Changelog', link: '/changelog' },
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
      description: '解析 HLS（.m3u8）播放列表，下载并合并为可播放文件。默认保留源编码并 transmux；需要重编码时再通过 transcode 显式启用。',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/guide/getting-started' },
          { text: 'API', link: '/zh/api/hls-downloader' },
          { text: '更新日志', link: '/zh/changelog' },
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
