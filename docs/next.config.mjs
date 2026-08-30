import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  reactCompiler: true,
  experimental: {
    turbopackRustReactCompiler: true,
  },
};

export default withMDX(config);
