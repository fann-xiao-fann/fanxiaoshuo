import { z } from 'zod';
import { isoDateTimeSchema, nonNegativeIntSchema } from './primitives.js';

/**
 * 组件健康状态：
 * - `ok`：探测成功
 * - `degraded`：可连通但存在告警（如 Worker 心跳过期）
 * - `down`：不可连通
 * - `unknown`：尚未探测
 */
export const componentStatusSchema = z.enum(['ok', 'degraded', 'down', 'unknown']);

export type ComponentStatus = z.infer<typeof componentStatusSchema>;

/** 单个依赖组件的探测结果。 */
export const componentHealthSchema = z.strictObject({
  status: componentStatusSchema,
  /** 主动探测往返耗时（ms）；Worker 为心跳键读取耗时 */
  latencyMs: nonNegativeIntSchema.nullable(),
  /** 可读诊断信息（失败原因），成功时通常为 null */
  message: z.string().max(500).nullable(),
  /** 仅 Worker 有意义：最近一次心跳时间 */
  lastHeartbeatAt: isoDateTimeSchema.nullable(),
  /** 仅 Worker 有意义：心跳上报的活跃任务数 */
  activeJobs: nonNegativeIntSchema.nullable(),
});

export type ComponentHealth = z.infer<typeof componentHealthSchema>;

/** 整体健康状态：全部组件 ok 才是 ok，否则 degraded。 */
export const healthStatusSchema = z.enum(['ok', 'degraded']);

export type HealthStatus = z.infer<typeof healthStatusSchema>;

/** `GET /api/v1/health` 响应。 */
export const healthResponseSchema = z.strictObject({
  status: healthStatusSchema,
  checks: z.strictObject({
    postgres: componentHealthSchema,
    redis: componentHealthSchema,
    worker: componentHealthSchema,
  }),
  /** 服务端探测完成时间 */
  timestamp: isoDateTimeSchema,
  /** 服务版本号（来自 package.json） */
  version: z.string().min(1).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** 构造一个健康的组件探测结果（服务端与测试复用）。 */
export function okComponentHealth(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return {
    status: 'ok',
    latencyMs: 0,
    message: null,
    lastHeartbeatAt: null,
    activeJobs: null,
    ...overrides,
  };
}
