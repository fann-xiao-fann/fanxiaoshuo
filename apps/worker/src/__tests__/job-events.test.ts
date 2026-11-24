import { describe, expect, it } from 'vitest';
import { REDIS_CHANNELS, jobEventSchema } from '@fanxiaoshuo/shared';
import { createJobEvent, createJobEventPublisher } from '../events/job-events.js';

describe('createJobEvent', () => {
  it('由 status 推导 type 并补齐默认字段', () => {
    const event = createJobEvent({
      jobId: 'job-1',
      status: 'completed',
      attemptsMade: 1,
      progress: 100,
      timestamp: new Date('2026-01-02T03:04:05.000Z'),
      data: { latencyMs: 12 },
    });

    expect(event).toEqual({
      type: 'job.completed',
      jobId: 'job-1',
      status: 'completed',
      timestamp: '2026-01-02T03:04:05.000Z',
      attemptsMade: 1,
      progress: 100,
      errorCode: null,
      errorMessage: null,
      data: { latencyMs: 12 },
    });
    expect(jobEventSchema.safeParse(event).success).toBe(true);
  });
});

describe('createJobEventPublisher', () => {
  it('发布到 fanxiaoshuo:events:jobs，消息为契约校验后的 JSON', async () => {
    const published: { channel: string; message: string }[] = [];
    const publisher = createJobEventPublisher({
      async publish(channel, message) {
        published.push({ channel, message });
        return 1;
      },
    });

    const event = await publisher({
      type: 'job.active',
      jobId: 'job-2',
      status: 'active',
      timestamp: '2026-01-02T03:04:05.000Z',
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe(REDIS_CHANNELS.jobEvents);
    expect(JSON.parse(published[0]?.message ?? '{}')).toEqual(event);
    expect(jobEventSchema.safeParse(JSON.parse(published[0]?.message ?? '{}')).success).toBe(true);
  });

  it('拒发 type 与 status 不自洽的事件', async () => {
    const publisher = createJobEventPublisher({
      async publish() {
        return 1;
      },
    });

    await expect(
      publisher({
        type: 'job.completed',
        jobId: 'job-3',
        status: 'active',
        timestamp: '2026-01-02T03:04:05.000Z',
      }),
    ).rejects.toThrow(/不匹配/);
  });
});
