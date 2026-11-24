/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 基础路径，默认 `/api/v1`（开发期经 Vite 代理转发到 Fastify） */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
