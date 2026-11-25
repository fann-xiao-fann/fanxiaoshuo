# Proposal: book-bible-and-ai-writer

## Why

完成书架与章节编辑器（Change 2）后，作者已经可以在「梵小说」中高效组织卷章和编写长文，但尚缺乏支撑长篇网文连贯创作的「设定记忆层（Book Bible）」与「编辑器内流式 AI 协作写作」能力。若没有统一的总大纲、人物/世界观设定卡、前文摘要召回与 Token 预算上下文组装，直接调用大模型极易出现人设漂移、设定冲突与失控耗费；同时章内 AI 写作必须建立在流式可控输出、统一计量审计与写前自动快照留底的安全护栏之上，才能为下一阶段批量流水线（Change 4）奠定可靠的单章成文引擎。

## What Changes

- 新增 **作品设定记忆层（Book Bible）**：
  - 为每本书提供结构化 **总大纲**（核心主线、世界观概览、文风与禁忌、阶段与结局规划）。
  - 提供 6 类 **设定卡（Knowledge Cards）** 管理（人物、世界观、势力、物品/金手指、伏笔、时间线），支持精炼摘要、详细设定、别名关键词、标签、常驻置顶（`pinned`）与分类搜索；数据库层预留 `pgvector` 不定维向量列，未配置向量模型时无缝回退至常驻与关键词相关性召回。
  - 为每章提供 **本章细纲与剧情摘要（Chapter Summary）**（细纲、剧情摘要、关键事件、出场人物），支持手工维护及一键调用 `lorekeeper` 角色从正文 AI 提炼摘要。
- 新增 **统一上下文组装器与预算预览（Context Assembler）**：
  - 在 `packages/agents` 实现确定性上下文拼装引擎，按优先级汇总总大纲、常驻/手动勾选/自动召回设定卡、前序 N 章摘要、上一章尾部衔接与当前章节细纲/正文，支持 Token 估算、超预算确定性裁剪与前端发送前透明预览。
- 新增 **编辑器内流式 AI 写作与安全应用（AI Chapter Writer）**：
  - 提供 4 种章内写作动作：`continue`（续写）、`expand`（扩写）、`rewrite`（改写）、`polish`（润色），通过 `POST + SSE` 流式推送增量内容、支持随时中止与重试。
  - 所有 AI 写作（`writer` 角色）与摘要提炼（`lorekeeper` 角色）100% 经 `ModelGateway` 执行并落盘 `llm_usage_logs` 审计账本；角色未绑定或模型停用时返回明确错误并引导跳转模型配置。
  - 新增原子应用端点 `POST /api/v1/chapters/:chapterId/ai/apply`：在校验章节乐观锁 `expectedVersion` 后，先自动创建一条 `source: 'ai'` 历史快照留底原稿，再写入新正文并递增版本号，确保任何 AI 写入绝不静默丢稿且可一键回滚。
- 扩展 **写作工作区编辑器（Chapter Editor）**：
  - 在 `BookWorkspaceView` 右侧集成可折叠的「设定集与 AI 助手」三标签侧栏（AI 写作 / 设定集 / 本章记忆），与 TipTap 选区、实时草稿及历史快照无缝联动；进入沉浸模式时自动隐藏右侧栏。

## Capabilities

### New Capabilities

- `book-bible`: 作品级总大纲、6 类结构化设定卡（含常驻置顶与关键词/向量召回扩展）、章节细纲与剧情摘要（含 `lorekeeper` 一键提炼）以及 Token 预算感知的上下文组装与预览能力。
- `ai-chapter-writer`: 基于统一 `ModelGateway` 与角色路由的章节内流式 AI 写作（续写、扩写、改写、润色）、实时 SSE 增量预览与中止、用量与成本审计落盘，以及带乐观锁校验和 `source: 'ai'` 自动快照留底的原子正文应用能力。

### Modified Capabilities

- `chapter-editor`: 写作工作区新增右侧可折叠的设定集与 AI 助手侧栏并与编辑器选区/保存联动；沉浸专注写作模式同时收起右侧助手侧栏以保持无干扰居中写作体验。

## Impact

- **`packages/shared`**：新增 Book Bible 与 AI 写作领域枚举、错误码（`KNOWLEDGE_CARD_NOT_FOUND`、`AI_EMPTY_CONTEXT`）、总大纲/设定卡/章节摘要/上下文预览/AI 流式请求与 SSE 帧/安全应用 Zod v4 契约。
- **`packages/agents`**：新增 CJK+拉丁 Token 估算器、设定卡相关性与余弦相似度召回器、预算感知上下文组装器、4 种写作动作及摘要提炼的原创中文 Prompt 模板与结构化摘要容错解析器。
- **`apps/server`**：新增 Drizzle 迁移 `0002_*.sql`（`book_outlines`、`knowledge_cards`、`chapter_summaries` 三张表及索引，含 `pgvector` 可选 `embedding` 列），新增对应仓储、REST 接口、POST+SSE 流式写作路由与原子 AI 应用路由。
- **`apps/web`**：新增 `book-bible` API 客户端与通用 `fetch` SSE 解析器、`book-bible` Pinia Store，以及写作工作区右侧三标签助手侧栏（`WorkspaceAssistantPanel` / `AiWriterPanel` / `BookBiblePanel` / `ChapterMemoryPanel`），并联动 `ChapterTipTapEditor` 选区读取与安全写回。
- **非目标（明确留待后续 Change）**：多章无人值守批量流水线与 BullMQ 编排（Change 4）、外部独立 Embedding 向量化后台任务调度与审稿返工裁判闭环（Change 4）、创作工具盒 Schema 驱动表单（Change 5）。
