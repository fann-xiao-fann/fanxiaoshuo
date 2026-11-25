import { describe, expect, it } from 'vitest';
import { REDIS_CHANNELS, workflowEventSchema, type WorkflowEvent } from '@fanxiaoshuo/shared';
import { createWorkflowEvent, createWorkflowEventPublisher } from '../events/workflow-events.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const BOOK_ID = '22222222-2222-4222-8222-222222222222';

describe('createWorkflowEvent', () => {
  it('由批次状态推导事件类型并补齐默认字段', () => {
    const event = createWorkflowEvent({
      runId: RUN_ID,
      bookId: BOOK_ID,
      status: 'paused',
      pauseReason: 'BUDGET_EXCEEDED',
      totalSteps: 3,
      completedSteps: 1,
      failedSteps: 0,
      spentCostUsd: 0.42,
      maxCostUsd: 0.4,
      timestamp: new Date('2024-05-01T00:00:00.000Z'),
    });

    expect(event).toEqual({
      type: 'workflow.paused',
      runId: RUN_ID,
      bookId: BOOK_ID,
      status: 'paused',
      timestamp: '2024-05-01T00:00:00.000Z',
      totalSteps: 3,
      completedSteps: 1,
      failedSteps: 0,
      spentCostUsd: 0.42,
      maxCostUsd: 0.4,
      pauseReason: 'BUDGET_EXCEEDED',
      stepId: null,
      chapterId: null,
      stepIndex: null,
      stepStatus: null,
      stepStage: null,
      criticScore: null,
      errorCode: null,
      errorMessage: null,
    });
  });

  it('步骤阶段事件可显式覆盖事件类型', () => {
    const event = createWorkflowEvent({
      type: 'workflow.step_updated',
      runId: RUN_ID,
      bookId: BOOK_ID,
      status: 'running',
      totalSteps: 2,
      completedSteps: 0,
      failedSteps: 0,
      spentCostUsd: 0,
      maxCostUsd: null,
      stepId: '33333333-3333-4333-8333-333333333333',
      stepIndex: 0,
      stepStatus: 'running',
      stepStage: 'writing',
      criticScore: 88,
    });

    expect(event.type).toBe('workflow.step_updated');
    expect(event.stepStage).toBe('writing');
    expect(event.criticScore).toBe(88);
    expect(event.pauseReason).toBeNull();
  });
});

describe('createWorkflowEventPublisher', () => {
  it('发布前经 workflowEventSchema 校验并写入 fanxiaoshuo:events:workflows', async () => {
    const published: Array<{ channel: string; message: string }> = [];
    const publishEvent = createWorkflowEventPublisher({
      async publish(channel, message) {
        published.push({ channel, message });
      },
    });

    const event = await publishEvent({
      type: 'workflow.running',
      runId: RUN_ID,
      bookId: BOOK_ID,
      status: 'running',
      timestamp: '2024-05-01T00:00:00.000Z',
      totalSteps: 2,
      completedSteps: 0,
      failedSteps: 0,
      spentCostUsd: 0,
      maxCostUsd: 5,
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe(REDIS_CHANNELS.workflowEvents);
    expect(published[0]?.channel).toBe('fanxiaoshuo:events:workflows');
    expect(JSON.parse(published[0]?.message ?? '{}')).toEqual(event);
    expect(workflowEventSchema.parse(JSON.parse(published[0]?.message ?? '{}'))).toEqual(event);
  });

  it('非法事件直接被契约拦截，且不会发布到 Redis', async () => {
    const published: string[] = [];
    const publishEvent = createWorkflowEventPublisher({
      async publish(_channel, message) {
        published.push(message);
      },
    });

    const invalid = {
      type: 'workflow.unknown',
      runId: RUN_ID,
      bookId: BOOK_ID,
      status: 'running',
      timestamp: 'not-a-date',
      totalSteps: -1,
      completedSteps: 0,
      failedSteps: 0,
      spentCostUsd: 0,
      maxCostUsd: null,
    } as unknown as WorkflowEvent;

    await expect(publishEvent(invalid)).rejects.toThrow();
    expect(published).toHaveLength(0);
  });
});
