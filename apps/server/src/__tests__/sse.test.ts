import type { JobEvent } from '@fanxiaoshuo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServerContext } from './helpers/in-memory.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('GET /api/v1/runtime/events (SSE)', () => {
  let context: TestServerContext | null = null;
  let abortController: AbortController | null = null;

  afterEach(async () => {
    abortController?.abort();
    await context?.app.close();
    context = null;
    abortController = null;
  });

  it('推送 ready 帧、转发 job 事件、发送心跳并在断开后退订', async () => {
    context = await createTestServer({ sseHeartbeatMs: 40 });
    const baseUrl = await context.app.listen({ host: '127.0.0.1', port: 0 });

    abortController = new AbortController();
    const response = await fetch(`${baseUrl}/api/v1/runtime/events`, {
      headers: { accept: 'text/event-stream' },
      signal: abortController.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readChunk = async (marker: string): Promise<{ done: boolean; value?: Uint8Array }> => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`SSE 读取超时（等待 ${marker}）`)), 2_000);
      });
      try {
        return await Promise.race([reader.read(), timeout]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    };

    const readUntil = async (marker: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!buffer.includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(`等待 SSE 片段超时：${marker}；当前缓冲：${buffer}`);
        }
        const chunk = await readChunk(marker);
        if (chunk.done) {
          throw new Error(`SSE 连接提前结束（等待 ${marker}）`);
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };

    await readUntil('event: ready');

    const activeEvent: JobEvent = {
      type: 'job.active',
      jobId: 'job-sse-1',
      status: 'active',
      timestamp: new Date('2025-01-01T00:00:05.000Z').toISOString(),
      attemptsMade: 1,
      progress: 50,
      errorCode: null,
      errorMessage: null,
    };
    context.eventBus.emit(activeEvent);
    await readUntil('event: job-event');
    await readUntil('"jobId":"job-sse-1"');
    await readUntil('"progress":50');

    await readUntil('event: ping');

    expect(context.eventBus.handlers.size).toBe(1);

    await reader.cancel().catch(() => undefined);
    abortController.abort();
    const releaseDeadline = Date.now() + 3_000;
    while (context.eventBus.handlers.size > 0 && Date.now() < releaseDeadline) {
      await delay(25);
    }

    expect(context.eventBus.handlers.size).toBe(0);
    expect(context.eventBus.unsubscribeCount).toBeGreaterThanOrEqual(1);
  });
});
