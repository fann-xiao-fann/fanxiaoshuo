import { healthResponseSchema, type HealthResponse } from '@fanxiaoshuo/shared';
import { apiRequest } from './http';

/** `/api/v1/health`：API / PostgreSQL / Redis / Worker 主动探测。 */
export const healthApi = {
  get(options: { signal?: AbortSignal } = {}): Promise<HealthResponse> {
    return apiRequest('/health', healthResponseSchema, { signal: options.signal });
  },
};
