import {
  usageLogsResponseSchema,
  type UsageLogsQueryPayload,
  type UsageLogsResponse,
} from '@fanxiaoshuo/shared';
import { apiRequest } from './http';

/** 清洗查询参数：空字符串与 undefined 统一剔除，交由共享 Zod Schema 兜底默认值。 */
function toQuery(payload: UsageLogsQueryPayload): Record<string, string | number | undefined> {
  const entries: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    if (typeof value === 'number') {
      entries[key] = value;
      continue;
    }
    entries[key] = String(value);
  }
  return entries;
}

/** `/api/v1/usage-logs`：分页明细 + 区间汇总。 */
export const usageLogApi = {
  list(query: UsageLogsQueryPayload = {}): Promise<UsageLogsResponse> {
    return apiRequest('/usage-logs', usageLogsResponseSchema, { query: toQuery(query) });
  },
};
