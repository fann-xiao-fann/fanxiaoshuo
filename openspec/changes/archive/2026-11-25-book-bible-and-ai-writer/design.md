# Design: book-bible-and-ai-writer

## Context

Change 1 与 Change 2 已完成以下底座并归档：
- `packages/shared`：Zod v4 共享契约、统一错误码、`countNovelWords`、`USAGE_SCENES`（已预留 `chapter-write` 与 `lore-extract`）、`REVISION_SOURCES`（已预留 `ai`）。
- `packages/agents`：`ModelGateway`（`generateText` / `streamText` / `testConnectivity`，内置超时取消、脱敏、用量计量与 `usageLogger` 回调）与 4 个写书角色定义（`showrunner` / `lorekeeper` / `writer` / `critic`）。
- `apps/server`：Fastify 5 + Drizzle ORM + PostgreSQL（`pgvector/pgvector:pg17`，`vector 0.8.7` 扩展已启用），8 张核心表，章节乐观锁 `version` 与 `chapter_revisions` append-only 快照表。
- `apps/web`：Vue 3 + Pinia + Naive UI + TipTap 3.35.0 写作工作区（`BookWorkspaceView` + `ChapterTipTapEditor` + `useBookWorkspaceStore`）。

Change 3 在此基础上构建「Book Bible 设定记忆层 + 上下文组装器 + 章内流式 AI 写作与安全应用」，使单本书的创作闭环真正跑通，并为 Change 4 批量写书流水线复用同一套记忆层、上下文拼装器与 Prompt 资产。

## Goals / Non-Goals

**Goals:**
- 建立作品级总大纲、6 类结构化设定卡与章节级细纲/剧情摘要的持久层与完整 REST CRUD。
- 在 `packages/agents` 提供纯函数、可单测的 Token 估算器、设定卡召回器（常驻 + 手动勾选 + 关键词/别名打分 + 可选向量余弦相似度）、预算感知上下文组装器、4 种写作动作 Prompt 与 `lorekeeper` 摘要提炼解析器。
- 提供 `POST /api/v1/chapters/:chapterId/ai/stream` SSE 流式写作与 `POST /api/v1/chapters/:chapterId/summary/extract` 摘要提炼，100% 经过 `ModelGateway` 落盘 `llm_usage_logs`，支持随时取消且绝不泄露明文密钥。
- 提供原子端点 `POST /api/v1/chapters/:chapterId/ai/apply`，单事务内完成乐观锁校验、写前 `source: 'ai'` 快照留底与正文更新。
- 在写作工作区右侧提供可折叠三标签侧栏（AI 写作 / 设定集 / 本章记忆），与 TipTap 选区、实时草稿与版本历史无缝集成。

**Non-Goals:**
- 不实现多章无人值守批量执行引擎、BullMQ 工作流编排或自动审稿返工循环（留待 Change 4）。
- 不强制要求用户预先配置 Embedding 向量模型即可使用设定卡召回；数据库预留 `vector` 列与算法预留余弦相似度加权接口，但无向量时默认零配置可用。
- 不实现多人实时协同冲突合并（沿用乐观锁 `expectedVersion`）。

## Decisions

### 1. 数据库 Schema 设计（Drizzle 迁移 `0002_*.sql`）

在 `apps/server/src/db/schema.ts` 新增 3 张表（列默认值使用字面量以兼容 `drizzle-kit generate`）：

1. **`book_outlines`**（1:1 绑定 `books`）：
   - `book_id uuid PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE`
   - `main_plot text NOT NULL DEFAULT ''`
   - `world_setting text NOT NULL DEFAULT ''`
   - `style_guide text NOT NULL DEFAULT ''`
   - `ending_plan text NOT NULL DEFAULT ''`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - **理由**：与 `books` 主表解耦，避免 `GET /api/v1/books` 书架列表拉取大段大纲文本；`GET /books/:bookId/outline` 在无记录时直接返回空默认结构 + `updatedAt: null`，消除新书首次打开的 404 分支。

2. **`knowledge_cards`**（N:1 绑定 `books`）：
   - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
   - `book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE`
   - `category text NOT NULL`（`character | world | faction | item | foreshadowing | timeline`）
   - `title text NOT NULL`
   - `summary text NOT NULL DEFAULT ''`
   - `content text NOT NULL DEFAULT ''`
   - `aliases jsonb NOT NULL DEFAULT '[]'::jsonb`（`string[]`）
   - `tags jsonb NOT NULL DEFAULT '[]'::jsonb`（`string[]`）
   - `pinned boolean NOT NULL DEFAULT false`
   - `sort_order integer NOT NULL DEFAULT 0`
   - `embedding vector`（使用 Drizzle `customType` 声明不定维 `vector`，兼容 pgvector 0.8 任意维度模型；可空）
   - `embedding_model_ref text`（可空）
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - 索引：`knowledge_cards_book_category_sort_idx(book_id, category, sort_order)`、`knowledge_cards_book_pinned_idx(book_id, pinned)`。
   - **理由**：不写死 `vector(1536)`，防止后续更换 768/1024/3072 维向量模型被迫重建表；DTO 仅暴露 `hasEmbedding: boolean` 与 `embeddingModelRef`，不向前端下发原始浮点数组。

3. **`chapter_summaries`**（1:1 绑定 `chapters`）：
   - `chapter_id uuid PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE`
   - `book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE`
   - `outline text NOT NULL DEFAULT ''`
   - `summary text NOT NULL DEFAULT ''`
   - `key_events jsonb NOT NULL DEFAULT '[]'::jsonb`（`string[]`）
   - `characters_present jsonb NOT NULL DEFAULT '[]'::jsonb`（`string[]`）
   - `source text NOT NULL DEFAULT 'manual'`（`manual | ai`）
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - 索引：`chapter_summaries_book_idx(book_id)`。
   - **理由**：冗余 `book_id` + 索引，便于按书籍一次查出全部章摘要并按卷章阅读顺序切片前序 N 章。

> 迁移安全：`0002_*.sql` 顶部保留 `CREATE EXTENSION IF NOT EXISTS vector;`（若 Drizzle 未自动生成则确保迁移前可用；`infra/postgres/init/001-extensions.sql` 亦已启用），确保任何空库幂等执行 `pnpm db:migrate` 均成功。

### 2. REST 与 SSE 接口契约（唯一真相来源：`packages/shared`）

| 方法与路径 | 说明 | 请求 / 响应契约 |
| --- | --- | --- |
| `GET /api/v1/books/:bookId/outline` | 读取全书总大纲（无记录返回默认空结构） | `bookOutlineDtoSchema` |
| `PUT /api/v1/books/:bookId/outline` | 保存/更新全书总大纲 | `upsertBookOutlineSchema` → `bookOutlineDtoSchema` |
| `GET /api/v1/books/:bookId/cards` | 列出设定卡（`?category=&q=&pinned=`） | `knowledgeCardListResponseSchema` |
| `POST /api/v1/books/:bookId/cards` | 新建设定卡 | `createKnowledgeCardSchema` → `201` `knowledgeCardDtoSchema` |
| `GET /api/v1/books/:bookId/cards/:cardId` | 读取单张设定卡详情 | `knowledgeCardDtoSchema` |
| `PATCH /api/v1/books/:bookId/cards/:cardId` | 更新设定卡（含置顶切换） | `updateKnowledgeCardSchema` → `knowledgeCardDtoSchema` |
| `DELETE /api/v1/books/:bookId/cards/:cardId` | 删除设定卡 | `204 No Content` |
| `GET /api/v1/chapters/:chapterId/summary` | 读取本章细纲与摘要（无记录返回空默认） | `chapterSummaryDtoSchema` |
| `PUT /api/v1/chapters/:chapterId/summary` | 手工保存本章细纲与摘要（`source='manual'`） | `upsertChapterSummarySchema` → `chapterSummaryDtoSchema` |
| `POST /api/v1/chapters/:chapterId/summary/extract` | `lorekeeper` 从正文 AI 提炼摘要 | `extractChapterSummarySchema` → `extractChapterSummaryResponseSchema` |
| `POST /api/v1/chapters/:chapterId/ai/context-preview` | 预览上下文组装结果与 Token 占用 | `aiContextPreviewRequestSchema` → `aiContextPreviewResponseSchema` |
| `POST /api/v1/chapters/:chapterId/ai/stream` | 流式 AI 章节写作（`POST + SSE`） | `aiChapterStreamRequestSchema` → SSE (`start` / `delta` / `done` / `error`) |
| `POST /api/v1/chapters/:chapterId/ai/apply` | 原子应用 AI 正文（先留 `ai` 快照再更新） | `applyAiChapterContentSchema` → `applyAiChapterContentResponseSchema` |

SSE 帧格式与 `runtime.ts` 保持一致（`event: <name>\ndata: <single-line JSON>\n\n`），4 种事件名由 `AI_STREAM_EVENT_NAMES` 锁定：
- `start`: `aiStreamStartEventSchema`（`runId`, `chapterId`, `action`, `role`, `modelRef`, `estimatedContextTokens`, `truncated`, `includedCardIds`）
- `delta`: `aiStreamDeltaEventSchema`（`runId`, `text`）
- `done`: `aiStreamDoneEventSchema`（`runId`, `fullText`, `finishReason`, `inputTokens`, `outputTokens`, `estimatedCostUsd`, `latencyMs`, `modelRef`, `usageLogId`）
- `error`: `aiStreamErrorEventSchema`（`runId`, `code`, `message`）

### 3. 上下文组装与确定性裁剪策略（`packages/agents`）

- **前序章节定位**：服务端按本书活跃分卷 `sortOrder` 升序（各卷内活跃章 `sortOrder` 升序）+ 未分卷活跃章 `sortOrder` 升序展平为阅读序列，取当前章之前的最近 `maxRecentSummaries`（默认 3，上限 10）章的摘要，以及紧邻上一章正文的最后 `prevChapterTailChars`（默认 800 字）。
- **设定卡召回排序**：
  1. 用户在 `cardIds` 中显式勾选的卡片（最高优先，标记 `reason: 'selected'`）
  2. `pinned: true` 的常驻卡片（标记 `reason: 'pinned'`）
  3. 其余卡片基于查询文本（当前章标题 + 本章细纲 + 选区/当前正文尾部 + 用户指令）按标题命中（+10）、别名命中（+8）、标签命中（+3）、摘要/正文关键字命中（+1）与可选余弦相似度加权打分，取分数 > 0 的 Top-K（默认最多 8 张，标记 `reason: 'recalled'`）。
- **Token 预算与确定性裁剪**：
  - 使用确定性估算函数 `estimateTokens(text)`（CJK 字符按 1.0、拉丁词按 1.3、其余符号按 0.5 向上取整），无需引入重型 WASM tokenizer。
  - 超出 `maxContextTokens`（默认 8000，范围 1000–128000）时按从低到高优先级依次裁剪：
    1. 缩减非置顶自动召回设定卡（仅保留 `summary` 或移除低分卡）
    2. 缩减远期前序章节摘要条数
    3. 截断上一章尾部衔接长度（保留最近部分）
    4. 截断当前章过长前文（保留尾部最新上下文）
  - 总大纲精简摘要、当前章细纲、选区正文与本轮用户指令始终保留，裁剪发生时置 `truncated = true`。

### 4. 模型角色解析、流式取消与原子应用安全网

- **角色解析复用于服务层辅助模块** `apps/server/src/services/model-resolver.ts`：
  - 按 `role` 查 `agent_role_bindings` → 不存在抛 `409 AGENT_ROLE_UNBOUND`。
  - 查 `models.findWithProvider(binding.modelId)` → 校验 `provider.isEnabled`（`409 PROVIDER_DISABLED`）与 `model.isEnabled`（`409 MODEL_DISABLED`）。
  - 通过 `deps.codec.decrypt` 解密 API Key，拼装 `ResolvedModelConfig` + 角色默认 `temperature` / `maxTokens`。
  - 所有错误在 SSE `reply.hijack()` 之前抛出，使前端收到标准 JSON `ApiError`。
- **流式取消与用量审计**：
  - 监听 `request.raw` / `reply.raw` 的 `close` 事件，若客户端提前断开则触发 `abortController.abort()` 并调用 `gatewayStream.close()`。
  - 正常消费完 `stream.textStream` 后 `await stream.usage` 与 `await stream.finishReason`：因 `ModelGateway.streamText` 会在 `usagePromise` 内 `await emitUsageLog(usageLogger, successLog)`，此时注入的 `usageLogger` 已落盘 `llm_usage_logs` 并回填 `usageLogId`，再发出最终 `event: done`。
  - 失败时捕获并经 `sanitizeErrorMessage` 脱敏后发送 `event: error` 并关闭流；上游调用单次不自动无限重试，由用户在界面显式点击「重试」控制成本。
- **原子 AI 正文应用**：
  - `deps.chapters.applyAiContent(...)` 在单事务内锁定章节行校验 `version === expectedVersion`：不匹配返回 `conflict`（路由抛 `409 CHAPTER_VERSION_CONFLICT` + `currentVersion` 详情）；匹配则先向 `chapter_revisions` 插入 `source: 'ai'` 备份快照，再更新 `chapters` 正文、服务端 `countNovelWords` 字数与 `version + 1`。

### 5. 目录所有权与 Git Worktree 并行波次

严格遵循 `AGENTS.md` 目录所有权划分：
- **Wave 1（串行先行，冻结契约）**：`packages/shared`（`feat/c3-shared`）
- **Wave 2（共享契约合入 `main` 后并行双 Worktree）**：
  - `packages/agents`（`feat/c3-agents`）：Token 估算、卡片召回、上下文组装、写作/摘要 Prompt 与单测
  - `apps/web`（`feat/c3-web`）：`fetch` SSE 客户端、Book Bible API & Store、写作工作区右侧三标签助手栏、TipTap 选区联动与单测
- **Wave 3（`agents` 合入 `main` 后执行，确保直接复用 `packages/agents` 稳定导出）**：
  - `apps/server`（`feat/c3-server`）：Drizzle 迁移 `0002_*.sql`、仓储实现、角色解析辅助、REST & SSE 路由、原子 AI 应用事务与集成测试
- **Wave 4（集成验证）**：全仓 `typecheck` / `test` / `build`、真实 Docker PostgreSQL 幂等迁移验证、本地 Mock OpenAI 兼容流式服务端到端冒烟验证、跨包契约缝隙审查与 `README.md` 更新。

## Risks / Trade-offs

- **Risk 1：无 Embedding 模型时的语义召回精度** → **Mitigation**：以「手动勾选 + `pinned` 常驻 + 名称/别名/标签关键词打分」作为默认零配置召回主链路，同时数据库已就绪 `pgvector` `vector` 列且 `packages/agents` 暴露余弦相似度加权接口，后续启用向量化无缝增强。
- **Risk 2：弱模型执行 `lorekeeper` 摘要提炼不遵守 JSON 格式** → **Mitigation**：Prompt 要求严格 JSON 输出，同时 `parseExtractedSummary` 实现 Markdown 代码块剥离、局部 JSON 对象抽取及纯文本兜底解析，保证不会因模型格式抖动报错失败。
- **Risk 3：SSE 响应与 `z.strictObject` 前后端字段漂移** → **Mitigation**：所有 REST DTO 与 4 种 SSE 帧均在 `packages/shared` 定义 `z.strictObject`，服务端发送前与前端解析时共同校验，且在 Wave 4 增加真实 HTTP 流式端到端验收。
- **Risk 4：浏览器 `EventSource` 仅支持 GET 无法发送长上下文 POST Body** → **Mitigation**：前端采用标准 `fetch` + `ReadableStream` + `AbortController` 解析 `text/event-stream`，既支持大请求体又原生支持一键中止与非 2xx JSON 错误直出。
- **Risk 5：长章节正文较大时右侧 AI 应用覆盖本地未保存编辑** → **Mitigation**：点击「应用到正文」前先自动冲刷本地脏草稿（或以最新服务端 `expectedVersion` 原子提交），命中冲突直接弹出既有版本冲突弹窗，绝不静默丢稿。
