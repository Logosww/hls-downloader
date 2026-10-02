import { defineConfig } from 'wxt';
export default defineConfig({
  imports: false,
  manifest: {
    name: 'HLS published package acceptance',
    permissions: ['declarativeNetRequestWithHostAccess'],
    host_permissions: ['http://127.0.0.1/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
