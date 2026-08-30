import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  experimental: {
    turbopackRustReactCompiler: true,
  },
};

export default nextConfig;
