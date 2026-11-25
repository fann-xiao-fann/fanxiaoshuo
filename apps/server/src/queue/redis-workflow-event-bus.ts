import { REDIS_CHANNELS, workflowEventSchema, type WorkflowEvent } from '@fanxiaoshuo/shared';
import type { WorkflowEventBus, Unsubscribe } from './types.js';
import type { RedisPubSubLike } from './redis-event-bus.js';

/**
 * 批量流水线 Redis Pub/Sub 事件总线。
 *
 * - 频道：`REDIS_CHANNELS.workflowEvents`（`'fanxiaoshuo:events:workflows'`），
 *   与 Worker 发布端严格一致；
 * - `publish`：路由在创建 / 续跑 / 暂停 / 取消时广播批次级事件（Worker 负责步骤级事件）；
 * - `subscribe`：`GET /api/v1/workflows/events` SSE 端点订阅，按引用计数管理底层
 *   Redis 订阅，最后一个客户端断开时自动退订；
 * - 所有消息均经 `workflowEventSchema` 严格校验，脏帧直接丢弃，绝不污染前端状态。
 */
export function createRedisWorkflowEventBus(options: {
  publisher: RedisPubSubLike;
  subscriber: RedisPubSubLike;
  channel?: string;
}): WorkflowEventBus {
  const channel = options.channel ?? REDIS_CHANNELS.workflowEvents;
  const handlers = new Set<(event: WorkflowEvent) => void>();
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
    const parsed = workflowEventSchema.safeParse(parsedJson);
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
      const valid = workflowEventSchema.parse(event);
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
