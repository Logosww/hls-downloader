---
layout: home

hero:
  name: HLS Downloader
  text: TypeScript HLS 下载库
  tagline: 解析 HLS（.m3u8）播放列表，下载并合并为可播放文件。默认走轻量 transmux — 仅在指定转码时按需加载 FFmpeg。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: brand
      text: 在线演示
      link: https://hls-downloader-web-app.vercel.app
    - theme: alt
      text: API 参考
      link: /zh/api/hls-downloader
    - theme: alt
      text: GitHub
      link: https://github.com/Logosww/hls-downloader

features:
  - title: 默认轻量
    details: 普通下载经 transmux/remux 合并，不加载 FFmpeg。需要 FFmpeg 合并或转码时，通过 transcode 显式启用。
  - title: 双适配器
    details: 浏览器使用 BrowserAdapter，Node.js 使用 NodeAdapter（Rust N-API）— 统一的 API 接口。
  - title: TypeScript 优先
    details: 使用 TypeScript 编写，提供完整的类型定义。享受类型安全的 API 和出色的 IDE 支持。
  - title: 事件驱动的进度追踪
    details: 丰富的事件系统，实时追踪下载进度、分片合并和错误处理。
  - title: Monorepo 架构
    details: 模块化的包结构 — 可安装聚合包，也可按需引入作用域子包。
---
