import type {
  ComponentHealth,
  ComponentStatus,
  HealthResponse,
} from '@fanxiaoshuo/shared';
import { defineStore } from 'pinia';
import { describeError, isApiClientError } from '@/api/errors';
import { healthApi } from '@/api/health';

/** 轮询间隔：顶部徽章与状态页共享，避免重复探测。 */
export const HEALTH_POLL_INTERVAL_MS = 15_000;

export type OverallHealth = 'ok' | 'degraded' | 'down' | 'unknown';

const UNKNOWN_COMPONENT: ComponentHealth = {
  status: 'unknown',
  latencyMs: null,
  message: null,
  lastHeartbeatAt: null,
  activeJobs: null,
};

interface HealthState {
  data: HealthResponse | null;
  error: string | null;
  errorCode: string | null;
  loading: boolean;
  /** 前端视角的 API 往返耗时（ms），用于状态徽章展示 */
  apiLatencyMs: number | null;
  lastCheckedAt: number | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<void> | null;
}

let abortController: AbortController | null = null;

export const useHealthStore = defineStore('fx-health', {
  state: (): HealthState => ({
    data: null,
    error: null,
    errorCode: null,
    loading: false,
    apiLatencyMs: null,
    lastCheckedAt: null,
    pollTimer: null,
    inFlight: null,
  }),

  getters: {
    /** API 探针本身的状态：请求成功即 ok，失败即 down。 */
    apiStatus(state): ComponentStatus {
      if (state.error !== null) {
        return 'down';
      }
      return state.data !== null ? 'ok' : 'unknown';
    },
    postgres(state): ComponentHealth {
      return state.data?.checks.postgres ?? UNKNOWN_COMPONENT;
    },
    redis(state): ComponentHealth {
      return state.data?.checks.redis ?? UNKNOWN_COMPONENT;
    },
    worker(state): ComponentHealth {
      return state.data?.checks.worker ?? UNKNOWN_COMPONENT;
    },
    overall(state): OverallHealth {
      if (state.data === null) {
        return state.error !== null ? 'down' : 'unknown';
      }
      return state.data.status === 'ok' ? 'ok' : 'degraded';
    },
    overallLabel(): string {
      switch (this.overall as OverallHealth) {
        case 'ok':
          return '全链路正常';
        case 'degraded':
          return '部分依赖降级';
        case 'down':
          return '后端不可达';
        default:
          return '尚未探测';
      }
    },
    lastCheckedText(state): string {
      if (state.lastCheckedAt === null) {
        return '尚未检测';
      }
      return new Date(state.lastCheckedAt).toLocaleTimeString('zh-CN', { hour12: false });
    },
  },

  actions: {
    async refresh(): Promise<void> {
      if (this.inFlight !== null) {
        return this.inFlight;
      }
      abortController?.abort();
      abortController = new AbortController();
      this.loading = true;

      const task = (async () => {
        const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
        try {
          const response = await healthApi.get({ signal: abortController?.signal });
          const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
          this.apiLatencyMs = Math.max(0, Math.round(elapsed));
          this.data = response;
          this.error = null;
          this.errorCode = null;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return;
          }
          this.apiLatencyMs = null;
          this.data = null;
          this.error = describeError(error);
          this.errorCode = isApiClientError(error) ? error.code : 'NETWORK_ERROR';
        } finally {
          this.lastCheckedAt = Date.now();
          this.loading = false;
          this.inFlight = null;
        }
      })();

      this.inFlight = task;
      return task;
    },

    startPolling(intervalMs: number = HEALTH_POLL_INTERVAL_MS): void {
      if (this.pollTimer !== null) {
        return;
      }
      void this.refresh();
      this.pollTimer = setInterval(() => {
        void this.refresh();
      }, intervalMs);
    },

    stopPolling(): void {
      if (this.pollTimer !== null) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      abortController?.abort();
      abortController = null;
      this.inFlight = null;
    },
  },
});
