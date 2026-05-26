---
layout: home

hero:
  name: HLS Downloader
  text: TypeScript HLS Download Library
  tagline: Parse HLS (.m3u8) playlists and download/merge streams into playable files. Default downloads use lightweight transmux — FFmpeg loads only when you opt in with transcode.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: brand
      text: Live Demo
      link: https://hls-downloader-web-app.vercel.app
    - theme: alt
      text: API Reference
      link: /api/hls-downloader
    - theme: alt
      text: GitHub
      link: https://github.com/Logosww/hls-downloader

features:
  - title: Lightweight by Default
    details: Ordinary downloads transmux/remux without loading FFmpeg. Opt in with transcode when you need FFmpeg-based merging or encoding.
  - title: Dual Adapters
    details: BrowserAdapter for browsers and NodeAdapter (Rust N-API) for Node.js — one unified API.
  - title: TypeScript First
    details: Written in TypeScript with full type definitions. Enjoy type-safe APIs and excellent IDE support.
  - title: Event-Driven Progress
    details: Rich event system for tracking download progress, segment stitching, and error handling in real time.
  - title: Monorepo Architecture
    details: Modular packages — install the umbrella package or pick only what you need with scoped imports.
---
