import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // public/（时间线 JSON 数据）在仓库根，作为后端数据目录由 nginx 直接托管
  publicDir: '../public',
  server: {
    port: 5173,
    // 开发时把行为上报代理到本机直跑的 API（node deploy/api.mjs）
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
