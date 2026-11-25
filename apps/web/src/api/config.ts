import { API_PREFIX } from '@fanxiaoshuo/shared';

/**
 * API 基础路径。开发期默认 `/api/v1`，由 Vite dev proxy 转发到 Fastify；
 * 生产同源部署时同样使用相对路径，无需额外配置。
 */
function resolveApiBaseUrl(): string {
  const configured = import.meta.env?.VITE_API_BASE_URL;
  const raw = typeof configured === 'string' && configured.length > 0 ? configured : API_PREFIX;
  return raw.replace(/\/+$/, '');
}

export const API_BASE_URL = resolveApiBaseUrl();

/** SSE 事件流地址（辅助轮询兜底见 RuntimeView）。 */
export const RUNTIME_EVENTS_URL = `${API_BASE_URL}/runtime/events`;

/**
 * 批量流水线 SSE 事件流地址（帧名 `ready` / `workflow-event` / `ping`）。
 * 可用 `?runId=<uuid>` 只订阅单个批次；前端控制台默认订阅全量。
 */
export const WORKFLOW_EVENTS_URL = `${API_BASE_URL}/workflows/events`;
