import { sanitizeErrorMessage } from '@fanxiaoshuo/agents';
import {
  REDIS_KEYS,
  WORKER_HEARTBEAT,
  type ComponentHealth,
} from '@fanxiaoshuo/shared';

/** 组件健康探测接口（路由注入，测试可直接返回构造结果）。 */
export interface HealthProbes {
  checkPostgres(): Promise<ComponentHealth>;
  checkRedis(): Promise<ComponentHealth>;
  checkWorker(): Promise<ComponentHealth>;
}

/** 最小 PG 查询接口（`pg.Pool` 天然满足）。 */
export interface PostgresPingClient {
  query(queryText: string): Promise<unknown>;
}

/** 最小 Redis 读取接口（`ioredis` 天然满足）。 */
export interface RedisPingClient {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
}

const MAX_MESSAGE_LENGTH = 500;

function clampMessage(message: string): string {
  const sanitized = sanitizeErrorMessage(message);
  return sanitized.length > MAX_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : sanitized;
}

function failedComponent(error: unknown, startedAt: number): ComponentHealth {
  return {
    status: 'down',
    latencyMs: Math.max(0, Date.now() - startedAt),
    message: clampMessage(error instanceof Error ? error.message : String(error)),
    lastHeartbeatAt: null,
    activeJobs: null,
  };
}

/** PG：主动执行 `SELECT 1` 并记录往返延迟。 */
export function createPostgresHealthProbe(client: PostgresPingClient): () => Promise<ComponentHealth> {
  return async () => {
    const startedAt = Date.now();
    try {
      await client.query('SELECT 1');
      return {
        status: 'ok',
        latencyMs: Math.max(0, Date.now() - startedAt),
        message: null,
        lastHeartbeatAt: null,
        activeJobs: null,
      };
    } catch (error) {
      return failedComponent(error, startedAt);
    }
  };
}

/** Redis：`PING` 必须返回 PONG。 */
export function createRedisHealthProbe(client: RedisPingClient): () => Promise<ComponentHealth> {
  return async () => {
    const startedAt = Date.now();
    try {
      const reply = await client.ping();
      if (reply !== 'PONG') {
        return {
          status: 'degraded',
          latencyMs: Math.max(0, Date.now() - startedAt),
          message: `Redis PING 返回异常：${clampMessage(reply)}`,
          lastHeartbeatAt: null,
          activeJobs: null,
        };
      }
      return {
        status: 'ok',
        latencyMs: Math.max(0, Date.now() - startedAt),
        message: null,
        lastHeartbeatAt: null,
        activeJobs: null,
      };
    } catch (error) {
      return failedComponent(error, startedAt);
    }
  };
}

interface HeartbeatPayload {
  readonly timestamp?: unknown;
  readonly updatedAt?: unknown;
  readonly at?: unknown;
  readonly time?: unknown;
  readonly activeJobs?: unknown;
  readonly activeJobCount?: unknown;
}

function parseHeartbeatTimestamp(payload: HeartbeatPayload): Date | null {
  const raw = payload.timestamp ?? payload.updatedAt ?? payload.at ?? payload.time;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 兼容秒 / 毫秒时间戳
    return new Date(raw < 1_000_000_000_000 ? raw * 1000 : raw);
  }
  if (typeof raw === 'string') {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function parseActiveJobs(payload: HeartbeatPayload): number | null {
  const raw = payload.activeJobs ?? payload.activeJobCount;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  return null;
}

/**
 * Worker 心跳探测：读取 `fanxiaoshuo:worker:heartbeat`。
 * - 键不存在：down（Worker 未启动或已停止）
 * - 心跳时间超过 30s：degraded（进程可能卡死或已退出但键尚未过期）
 * - 新鲜心跳：ok，并回传 lastHeartbeatAt / activeJobs
 */
export function createWorkerHealthProbe(
  client: RedisPingClient,
  options: { now?: () => number } = {},
): () => Promise<ComponentHealth> {
  const maxAgeMs = WORKER_HEARTBEAT.ttlSeconds * 1000;
  const now = options.now ?? Date.now;

  return async () => {
    const startedAt = Date.now();
    try {
      const raw = await client.get(REDIS_KEYS.workerHeartbeat);
      const latencyMs = Math.max(0, Date.now() - startedAt);

      if (raw === null) {
        return {
          status: 'down',
          latencyMs,
          message: 'Worker 心跳键不存在：后台 Worker 可能未启动。',
          lastHeartbeatAt: null,
          activeJobs: null,
        };
      }

      let payload: HeartbeatPayload;
      try {
        payload = JSON.parse(raw) as HeartbeatPayload;
      } catch {
        return {
          status: 'degraded',
          latencyMs,
          message: 'Worker 心跳负载不是合法 JSON，请检查 Worker 心跳写入逻辑。',
          lastHeartbeatAt: null,
          activeJobs: null,
        };
      }

      const heartbeatAt = parseHeartbeatTimestamp(payload);
      const activeJobs = parseActiveJobs(payload);
      if (!heartbeatAt) {
        return {
          status: 'degraded',
          latencyMs,
          message: 'Worker 心跳负载缺少可解析的 timestamp 字段。',
          lastHeartbeatAt: null,
          activeJobs,
        };
      }

      const ageMs = Math.max(0, now() - heartbeatAt.getTime());
      if (ageMs > maxAgeMs) {
        return {
          status: 'degraded',
          latencyMs,
          message: `Worker 心跳已过期：最近上报距今 ${Math.round(ageMs / 1000)}s（阈值 ${WORKER_HEARTBEAT.ttlSeconds}s）。`,
          lastHeartbeatAt: heartbeatAt.toISOString(),
          activeJobs,
        };
      }

      return {
        status: 'ok',
        latencyMs,
        message: null,
        lastHeartbeatAt: heartbeatAt.toISOString(),
        activeJobs,
      };
    } catch (error) {
      return failedComponent(error, startedAt);
    }
  };
}

/** 组合生产环境三类探测。 */
export function createHealthProbes(options: {
  postgres: PostgresPingClient;
  redis: RedisPingClient;
  now?: () => number;
}): HealthProbes {
  return {
    checkPostgres: createPostgresHealthProbe(options.postgres),
    checkRedis: createRedisHealthProbe(options.redis),
    checkWorker: createWorkerHealthProbe(options.redis, {
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  };
}
