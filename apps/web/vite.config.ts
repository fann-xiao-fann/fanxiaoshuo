import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

/**
 * 梵小说前端构建配置。
 *
 * - 端口读取根 `.env` 的 `WEB_PORT`（默认 5173）。
 * - `/api` 代理到 `127.0.0.1:${API_PORT || 3001}`；SSE 端点（`/api/v1/runtime/events`）
 *   依赖 http-proxy 的流式转发，因此显式关闭超时、禁用压缩并覆写 `cache-control`，
 *   保证任务状态事件逐帧到达浏览器而不会被缓冲成一整块。
 */
export default defineConfig(({ mode }) => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const env = loadEnv(mode, repoRoot, '');
  const webPort = Number(env.WEB_PORT || process.env.WEB_PORT || 5173);
  const apiPort = Number(env.API_PORT || process.env.API_PORT || 3001);
  const apiTarget = env.API_PROXY_TARGET || `http://127.0.0.1:${apiPort}`;

  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    envDir: repoRoot,
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // 直接消费契约源码：避免前端构建依赖 shared 的 dist 产物，
        // 同时保证类型与 Zod Schema 与仓库唯一真相来源完全一致。
        '@fanxiaoshuo/shared': fileURLToPath(
          new URL('../../packages/shared/src/index.ts', import.meta.url),
        ),
      },
    },
    server: {
      port: Number.isFinite(webPort) ? webPort : 5173,
      strictPort: false,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          timeout: 0,
          proxyTimeout: 0,
          headers: {
            // 禁止中间层 gzip 缓冲，SSE 需要 identity 编码逐条推送
            'Accept-Encoding': 'identity',
          },
          configure: (proxy) => {
            proxy.on('proxyRes', (proxyRes) => {
              if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
                proxyRes.headers['cache-control'] = 'no-cache, no-transform';
                proxyRes.headers['x-accel-buffering'] = 'no';
              }
            });
          },
        },
      },
    },
    preview: {
      port: Number.isFinite(webPort) ? webPort : 5173,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
    },
  };
});
