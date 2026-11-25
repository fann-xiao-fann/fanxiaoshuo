/**
 * @fanxiaoshuo/agents — 梵小说 AI 管道包。
 *
 * 目录所有权：AI Pipeline Agent。
 * 对外只暴露稳定业务 API：统一 LLM 网关、用量计量、Mastra 运行时门面与写书角色定义。
 * 严禁从本包导出 Mastra / AI SDK 的内部不稳定类型。
 */
export * from './gateway/types.js';
export * from './gateway/errors.js';
export * from './gateway/cost.js';
export * from './gateway/sanitize.js';
export * from './gateway/provider-factory.js';
export * from './gateway/model-gateway.js';
export * from './gateway/usage.js';

export * from './runtime/roles.js';
export * from './runtime/create-runtime.js';

export * from './context/token-estimator.js';
export * from './context/card-recall.js';
export * from './context/context-assembler.js';

export * from './prompts/chapter-writer.js';
export * from './prompts/batch-workflow.js';
export * from './prompts/toolbox.js';

export * from './toolbox/run-toolbox-tool.js';

/**
 * 批量单章工作流：仅导出业务契约、固定 ID 与错误类型，
 * 绝不导出 `createBatchChapterWorkflow`（其签名引用 Mastra 内部类型）。
 */
export { BATCH_CHAPTER_WORKFLOW_ID } from './workflows/batch-chapter-workflow.js';
export type {
  BatchChapterStopDecision,
  BatchChapterWorkflowBudget,
  BatchChapterWorkflowChapterInput,
  BatchChapterWorkflowHooks,
  BatchChapterWorkflowInput,
  BatchChapterWorkflowModels,
  BatchChapterWorkflowOutput,
  BatchChapterWorkflowResult,
  BatchChapterWorkflowStageMeta,
  WorkflowRoleModelInput,
} from './workflows/batch-chapter-workflow.js';
