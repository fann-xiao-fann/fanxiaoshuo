# batch-workflows Specification

## Purpose

提供「梵小说」基于 Mastra 与 BullMQ 的多 Agent 无人值守批量写书流水线，贯通「Showrunner 批量拆细纲 → Writer 逐章连贯成文 → Critic 审稿与返工闭环 → Lorekeeper 自动摘要更新」，并内建预算熔断上限、安全暂停/断点续跑/取消/单步重试与实时 SSE 进度监控。

## Requirements

### Requirement: 批量写书流水线创建与角色前置校验
The system SHALL allow users to create a batch workflow run for an active book in one of three modes (`outline_only`, `write_chapters`, `full_pipeline`), targeting either selected existing chapters or newly auto-created chapters in a chosen volume, and MUST validate all required agent role bindings before enqueueing the run.

#### Scenario: 选定已有章节创建全链路批量任务并入队
- **WHEN** 用户选择一本活跃书籍、指定多个目标章节、配置 `full_pipeline` 模式（开启审稿返工与自动摘要）及预算上限 `maxCostUsd` 并提交创建
- **THEN** 服务端校验目标书籍、章节归属与所需写书角色（`showrunner`、`writer`、`critic`、`lorekeeper`）均已绑定可用模型，在单一事务中持久化 `workflow_runs` 与有序 `workflow_steps`，入队 BullMQ `novel-workflows` 队列并返回 `201` 完整批次详情

#### Scenario: 指定自动新建章节批量创建任务
- **WHEN** 用户在新建批次时选择自动新建 N 个章节（指定可选目标分卷、数量与标题前缀）
- **THEN** 服务端按序在目标分卷下创建对应空白章节并生成顺序绑定的 `workflow_steps`，随后入队执行

#### Scenario: 所需写书角色未绑定模型时拒绝创建
- **WHEN** 用户发起开启 `critic` 审稿的批量任务，但 `critic`（或其它必需角色）尚未在模型配置中心绑定有效模型或所属供应商已停用
- **THEN** 服务端在写入任务与入队之前拒绝请求，返回规范 `409` 错误（`AGENT_ROLE_UNBOUND` / `PROVIDER_DISABLED` / `MODEL_DISABLED`），不残留孤立批次记录

### Requirement: 多 Agent 逐章执行、审稿返工闭环与安全留底写入
The system SHALL execute workflow steps sequentially per run inside the background Worker via Mastra and `ModelGateway`, injecting up-to-date Book Bible context for each chapter, running bounded critic review-and-rework loops when enabled, backing up existing chapter text as a `source: 'ai'` revision before writing, and updating chapter summaries for downstream continuity.

#### Scenario: 逐章完成拆细纲、成文、审稿返工与摘要更新
- **WHEN** Worker 消费一个 `full_pipeline` 批次并依次执行第 1 章与第 2 章
- **THEN** 每章按序执行 `showrunner` 细纲规划 → `writer` 结合总大纲/设定卡/前序摘要成文 → `critic` 结构化打分（若未达 `minPassScore` 且未超 `maxReworkRounds`，携带审稿问题交由 `writer` 返工并复审）→ 事务内先留底 `source: 'ai'` 快照再写回正文、字数与版本 +1 → `lorekeeper` 提炼本章摘要
- **AND** 执行第 2 章时，其组装上下文自动纳入第 1 章刚刚生成的摘要与结尾正文，且每次模型调用均落盘 `llm_usage_logs`

#### Scenario: 单章失败记录脱敏错误并保留前序已完成章节
- **WHEN** 某章节在执行过程中遭遇上游故障或无法恢复的错误
- **THEN** 系统将脱敏错误码与错误摘要写入该步骤与批次记录（绝不泄露明文 API Key），保留此前已完成章节的正文、摘要与历史快照不受回滚破坏

### Requirement: 预算熔断保护与成本追踪
The system SHALL track cumulative input tokens, output tokens, and estimated USD cost per step and per run, and MUST enforce `maxCostUsd` as a hard circuit-breaker before model invocations to prevent runaway spending.

#### Scenario: 累计费用触及预算上限时自动熔断暂停
- **WHEN** 批量运行在执行到某一章或返工轮次前检测到 `spentCostUsd >= maxCostUsd`（或 `ModelGateway` 抛出 `BUDGET_EXCEEDED`）
- **THEN** Worker 立即停止后续模型调用，将批次状态转为 `paused` 并记录 `pauseReason: 'BUDGET_EXCEEDED'`，保留全部已完成章节成果

#### Scenario: 上调预算上限后从断点继续运行
- **WHEN** 用户对因预算熔断暂停的批次提高 `maxCostUsd` 并触发「继续运行（Resume）」
- **THEN** 系统更新该批次预算上限并将未完成步骤重置为 `pending` 重新入队，Worker 跳过已 `completed` 章节直接从断点继续推进

### Requirement: 暂停、断点续跑、取消与单步重试控制
The system SHALL support pausing an active run at safe chapter/round boundaries, resuming a paused or failed run from unfinished steps without redoing completed chapters, cancelling an active run, retrying an individual failed step, and deleting terminal runs.

#### Scenario: 暂停后断点续跑不重复覆盖已完成章节
- **WHEN** 用户对运行中批次点击「暂停」并在批次进入 `paused` 后再次点击「继续运行」
- **THEN** 已完成步骤保持 `completed` 不被重新执行，Worker 仅执行剩余 `pending` 步骤直至整批完成

#### Scenario: 取消排队中或运行中的批次
- **WHEN** 用户对 `queued`、`running` 或 `paused` 状态的批次触发「取消」
- **THEN** 批次状态收敛为 `cancelled`，未执行的剩余步骤标记为 `skipped`，已完成章节成果完整保留

#### Scenario: 重试单个失败步骤
- **WHEN** 用户对 `failed` 或 `paused` 批次中的某个 `failed` 步骤触发「重试」
- **THEN** 仅该步骤状态重置为 `pending` 且批次重新入队，Worker 仅补跑未完成步骤

### Requirement: 批量进度实时 SSE 推送与工作台控制台
The system SHALL publish workflow run and step progress events over Redis Pub/Sub, stream them to clients via Server-Sent Events (`GET /api/v1/workflows/events`), and provide a live `/workflows` workbench interface displaying runs, step timelines, critic scores, budget consumption, and lifecycle controls.

#### Scenario: 实时观察批次进度与步骤阶段流转
- **WHEN** 用户打开 `/workflows` 控制台并启动一个批量任务
- **THEN** 前端订阅 `GET /api/v1/workflows/events` 接收 `ready` 与 `workflow-event` 帧（辅以断线轮询兜底），实时刷新进度条、当前章节执行阶段（规划/成文/审稿/返工/摘要）、审稿得分、累计 Token 与估算费用，并提供快捷链接直达已生成章节的编辑器
