import { REDIS_CHANNELS, jobEventSchema, type JobEvent } from '@fanxiaoshuo/shared';
import type { JobEventBus, Unsubscribe } from './types.js';

/** ioredis 的最小结构接口（便于测试替换）。 */
export interface RedisPubSubLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  off(event: 'message', listener: (channel: string, message: string) => void): unknown;
}

/**
 * Redis Pub/Sub 事件总线：
 * - `publish`：Queue API 入队后广播 `job.queued`，Worker 负责后续状态事件；
 * - `subscribe`：SSE 端点订阅，按引用计数管理底层 Redis 订阅，断开时正确退订。
 */
export function createRedisJobEventBus(options: {
  publisher: RedisPubSubLike;
  subscriber: RedisPubSubLike;
  channel?: string;
}): JobEventBus {
  const channel = options.channel ?? REDIS_CHANNELS.jobEvents;
  const handlers = new Set<(event: JobEvent) => void>();
  let subscribed = false;

  const onMessage = (incomingChannel: string, message: string): void => {
    if (incomingChannel !== channel) {
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(message) as unknown;
    } catch {
      return;
    }
    const parsed = jobEventSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return;
    }
    for (const handler of handlers) {
      try {
        handler(parsed.data);
      } catch {
        // 单个 SSE 客户端异常不应影响其它订阅者。
      }
    }
  };

  return {
    async publish(event) {
      const valid = jobEventSchema.parse(event);
      await options.publisher.publish(channel, JSON.stringify(valid));
    },

    async subscribe(handler): Promise<Unsubscribe> {
      handlers.add(handler);
      if (!subscribed) {
        options.subscriber.on('message', onMessage);
        await options.subscriber.subscribe(channel);
        subscribed = true;
      }

      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        handlers.delete(handler);
        if (handlers.size === 0 && subscribed) {
          options.subscriber.off('message', onMessage);
          await options.subscriber.unsubscribe(channel);
          subscribed = false;
        }
      };
    },
  };
}
