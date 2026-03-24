---
layout: home

hero:
  name: HLS Downloader
  text: TypeScript HLS Download Library
  tagline: Parse HLS (.m3u8) playlists and download/merge streams into playable files. Pick an adapter for your runtime — WASM for browsers, Rust for Node.js.
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
  - title: Dual Adapters
    details: WASM adapter (FFmpeg WASM) for browsers and Rust adapter (N-API) for Node.js — one unified API.
  - title: TypeScript First
    details: Written in TypeScript with full type definitions. Enjoy type-safe APIs and excellent IDE support.
  - title: Event-Driven Progress
    details: Rich event system for tracking download progress, segment stitching, and error handling in real time.
  - title: Monorepo Architecture
    details: Modular packages — install the umbrella package or pick only what you need with scoped imports.
---
