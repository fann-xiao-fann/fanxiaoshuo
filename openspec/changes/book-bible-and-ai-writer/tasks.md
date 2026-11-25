# Tasks: book-bible-and-ai-writer

> 执行依赖与并行说明：
> - **Wave 1**（任务组 1，`[shared]`）必须最先完成并合入 `main`，锁定跨包契约。
> - **Wave 2**（任务组 2 `[agents]` 与任务组 3 `[web]`）可在 Wave 1 合入后通过两个独立 `git worktree` **并行开发**，目录边界互不重叠。
> - **Wave 3**（任务组 4 `[server]`）在 Wave 2 的 `[agents]` 合入 `main` 后执行，直接复用 `packages/agents` 的上下文组装器与 Prompt 导出。
> - **Wave 4**（任务组 5，集成验证）统一验收全仓构建、迁移、跨包缝隙与本地端到端流式冒烟。

## 1. 共享契约锁定（Wave 1 · 串行先行）

- [x] 1.1 `[shared]` 在 `packages/shared/src/constants/book-bible.ts` 与 `packages/shared/src/errors.ts` 新增 Book Bible 领域枚举与常量（6 类设定卡分类及中文标签、摘要来源、4 种 AI 写作动作及标签、3 种正文应用模式、SSE 事件名 `AI_STREAM_EVENT_NAMES`、默认上下文预算常量）与错误码（`KNOWLEDGE_CARD_NOT_FOUND`、`AI_EMPTY_CONTEXT`），并补齐单元测试验证错误码与 HTTP 状态码一一映射。
- [x] 1.2 `[shared]` 新增 `packages/shared/src/schemas/book-bible.ts` 与 `packages/shared/src/schemas/ai-writer.ts` 并从 `packages/shared/src/index.ts` 导出：定义总大纲、设定卡 CRUD 与筛选、章节细纲/摘要与提炼、上下文预览请求/响应、流式写作请求与 4 种 SSE 帧（`start`/`delta`/`done`/`error`）、原子 AI 正文应用请求/响应等 Zod v4 `strictObject` Schema，并编写单元测试覆盖合法输入、边界裁剪与非法拒绝用例。

## 2. AI 上下文组装器与写作 Prompt 引擎（Wave 2 · 可与任务组 3 并行）

- [x] 2.1 `[agents]` 在 `packages/agents/src/context/` 实现确定性 `estimateTokens` 估算器、设定卡相关性召回与 `cosineSimilarity` 排序器（按「手动勾选 > 常驻置顶 > 名称/别名/标签/内容关键词打分 + 可选向量余弦加权」排序），以及预算感知的 `assembleChapterContext` 组装器（超预算时确定性裁剪并标记 `truncated`），编写完整单元测试覆盖召回排序与超预算裁剪场景。
- [x] 2.2 `[agents]` 在 `packages/agents/src/prompts/` 实现 4 种章内写作动作（`continue`/`expand`/`rewrite`/`polish`）的原创中文提示词构建器，以及 `lorekeeper` 章节摘要提炼提示词与容错解析器 `parseExtractedSummary`（支持 JSON、代码块包裹 JSON 及纯文本兜底），从 `packages/agents/src/index.ts` 统一导出并补齐单元测试。

## 3. 前端设定集面板与流式 AI 写作工作区（Wave 2 · 可与任务组 2 并行）

- [x] 3.1 `[web]` 新增 `apps/web/src/api/sse-client.ts`（支持 `POST + fetch + ReadableStream + AbortSignal` 的通用 SSE 帧解析器，非 2xx 直接解析标准 `ApiError`）与 `apps/web/src/api/book-bible.ts`（总大纲、设定卡、章节摘要/提炼、上下文预览、流式写作与原子应用客户端），并新增 Pinia Store `apps/web/src/stores/book-bible.ts` 与单元测试（覆盖流式增量、中止、错误与原子应用状态收敛）。
- [x] 3.2 `[web]` 在 `apps/web/src/components/workspace/` 实现右侧三标签助手侧栏（`WorkspaceAssistantPanel.vue`、`AiWriterPanel.vue`、`BookBiblePanel.vue`、`ChapterMemoryPanel.vue`），支持总大纲编辑、6 类设定卡 CRUD/筛选/置顶、本章细纲与摘要编辑及 AI 一键提炼、上下文 Token 预算预览、4 动作流式生成与实时中止/重试、未绑定角色跳转 `/models` 引导，以及安全确认应用（追加/替换选区/替换全文）。
- [x] 3.3 `[web]` 升级 `ChapterTipTapEditor.vue` 与 `BookWorkspaceView.vue`：暴露编辑器当前选中文本与位置供 AI 写作面板联动，集成可折叠右侧助手栏，确保沉浸模式下自动隐藏右侧栏、同书切换章节时不重挂载编辑器（并修复 `BookWorkspaceView` 对 `bookId` 路由参数的监听），补齐组件/Store 单元测试确保 `pnpm --filter @fanxiaoshuo/web test` 与 `typecheck` 全绿。

## 4. 服务端数据库迁移、仓储与流式写作接口（Wave 3 · 依赖 Wave 2 的 `[agents]`）

- [x] 4.1 `[server]` 在 `apps/server/src/db/schema.ts` 新增 `book_outlines`、`knowledge_cards`（含 pgvector `vector` 可空列）与 `chapter_summaries` 三张表定义及索引，使用 `drizzle-kit generate` 生成迁移 `0002_*.sql`（确保含 `CREATE EXTENSION IF NOT EXISTS vector;` 幂等保障），并扩展 `apps/server/src/repositories/`（接口、Drizzle 实现与内存测试仓储，含 `chapters.applyAiContent` 单事务乐观锁 + `source: 'ai'` 快照留底方法）。
- [x] 4.2 `[server]` 新增 `apps/server/src/services/model-resolver.ts`（复用角色绑定查找、供应商/模型启停校验与密钥解密）与 `apps/server/src/routes/book-bible.ts`（总大纲、设定卡 CRUD 与筛选、章节细纲/摘要读写与 `lorekeeper` 摘要提炼），并编写 Fastify `app.inject()` 集成测试覆盖全部接口与错误路径。
- [x] 4.3 `[server]` 新增 `apps/server/src/routes/chapter-ai.ts` 并挂载至 `buildServer`：实现上下文预览 `POST /chapters/:chapterId/ai/context-preview`、流式写作 `POST /chapters/:chapterId/ai/stream`（含角色前置校验、`ModelGateway.streamText` 消费、客户端断开即调用 `close()`、脱敏 `error` 帧与 `llm_usage_logs` 审计写入）以及原子应用 `POST /chapters/:chapterId/ai/apply`，编写集成测试覆盖流式输出、角色未绑定 409、取消中止、用量落盘、AI 快照自动留底与版本冲突 409。

## 5. 全仓集成验收与文档更新（Wave 4 · 集成检查）

- [x] 5.1 `[server][web][agents][shared]` 在 `main` 分支合入所有波次并解决依赖后，执行跨包契约缝隙审查，运行 `pnpm typecheck`、`pnpm test`、`pnpm build` 以及真实 Docker PostgreSQL 幂等迁移 `pnpm db:migrate`（连跑两次验证 11 张表就绪）。
- [x] 5.2 `[server][web]` 启动本地 Mock OpenAI 兼容流式上游 + 真实 Fastify Server + Vite 前端，执行端到端冒烟验证（建书/建章 → 保存总大纲与设定卡 → 上下文预览 → 绑定 `writer`/`lorekeeper` 角色 → `POST /ai/stream` 真实流式续写并核对 `llm_usage_logs` → `POST /ai/apply` 核对 `source: 'ai'` 自动留底快照与一键回滚 → `POST /summary/extract` 核对 AI 摘要落盘 → 清理临时测试数据），更新 `README.md` 的 Change 3 接口与能力说明。

## Workflow follow-up

- Run `/openspec-verify-change` to verify implementation against all Change 3 specs and design requirements.
- Archive the change after user review and approval.
