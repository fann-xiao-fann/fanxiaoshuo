# Design: toolbox-and-polish

## 1. 架构决策与边界

- **为什么创作工具盒采用同步 Fastify REST 执行（不走 BullMQ Worker）**：
  - 工具盒单次执行仅发起 1 次结构化 LLM 调用（与 Change 3 的 `POST /chapters/:chapterId/summary/extract` 架构完全对称），交互延迟通常在 2–8 秒，同步返回结构化卡片体验最直接，且无需为单步交互引入额外的队列与 SSE 复杂度。
  - 因此本变更严格收敛在 4 个包：`packages/shared`、`packages/agents`、`apps/server`、`apps/web`，不改动 `apps/worker` 与 `infra/`。
- **契约先行（Schema-Driven Single Source of Truth）**：
  - 6 个内置工具的元数据定义 `TOOLBOX_TOOL_DEFINITIONS` 冻结在 `packages/shared/src/constants/toolbox.ts`，由 `packages/shared` 统一导出，前后端与 `packages/agents` 共享同一份定义与输入校验函数 `validateToolboxInputs`。
- **统一结构化输出 + 安全兜底**：
  - 所有 6 个工具共用同一输出契约 `ToolboxOutput`（`{ overview: string, items: ToolboxResultItem[] }`），每条 `item` 包含 `{ title, summary, content, aliases, tags, suggestedCardCategory }`。
  - 这让前端只需一套高质量结果卡片渲染器，并天然支持「一键保存为设定卡」与「一键写入全书总大纲」两种回写闭环。
- **所有模型调用 100% 经 `ModelGateway`**：
  - 执行场景标识 `USAGE_SCENES.toolboxRun = 'toolbox-run'`，自动落盘 `llm_usage_logs`，API Key 仅在服务端内存中解密且全程脱敏。

---

## 2. 共享契约冻结（`packages/shared`）

### 2.1 运行期常量与错误码扩展

1. `packages/shared/src/constants/runtime.ts`：
   - `USAGE_SCENES` 追加 `toolboxRun: 'toolbox-run'`。
   - 新增全量标签映射 `USAGE_SCENE_LABELS: Record<UsageScene, string>`：
     - `connectivity-test`: `'一键测通'`
     - `smoke-job`: `'冒烟任务'`
     - `chapter-write`: `'章节成文'`
     - `lore-extract`: `'设定抽取'`
     - `chapter-review`: `'审稿质检'`
     - `outline-plan`: `'细纲规划'`
     - `toolbox-run`: `'创作工具盒'`
2. `packages/shared/src/errors.ts`：
   - `TOOLBOX_TOOL_NOT_FOUND` → HTTP `404`
   - `TOOLBOX_RUN_NOT_FOUND` → HTTP `404`
   - `TOOLBOX_ITEM_OUT_OF_RANGE` → HTTP `400`

### 2.2 工具目录定义（`packages/shared/src/constants/toolbox.ts`）

- 枚举常量：
  - `TOOLBOX_CATEGORIES = ['planning', 'worldbuilding', 'drafting'] as const`
  - `TOOLBOX_CATEGORY_LABELS = { planning: '立项策划', worldbuilding: '设定构建', drafting: '剧情与质检' }`
  - `TOOLBOX_TOOL_IDS = ['book-pitch', 'character-designer', 'world-faction-builder', 'golden-finger-designer', 'plot-hook-brainstorm', 'text-polish-diagnose'] as const`
  - `TOOLBOX_FIELD_TYPES = ['text', 'textarea', 'select', 'number'] as const`
  - `TOOLBOX_APPLY_TARGETS = ['knowledge_card', 'book_outline'] as const`
  - `TOOLBOX_RUN_STATUSES = ['completed', 'failed'] as const`
  - `TOOLBOX_OUTLINE_FIELDS = ['mainPlot', 'worldSetting', 'styleGuide', 'endingPlan'] as const`
  - `TOOLBOX_OUTLINE_APPLY_MODES = ['append', 'replace'] as const`
- 6 个内置工具元数据（`TOOLBOX_TOOL_DEFINITIONS`）：
  1. `book-pitch`（书名与爆款简介策划 · `planning` · 默认角色 `showrunner` · 可回写 `['book_outline', 'knowledge_card']`）
     - `genre`（`text`, 必填, max 80）
     - `coreHook`（`textarea`, 必填, max 2000）
     - `audience`（`select`, 必填, 选项 `['男频爽文', '女频言情', '悬疑脑洞', '轻小说', '通用']`, 默认 `'男频爽文'`）
     - `count`（`number`, 可选, min 1, max 5, 默认 3）
  2. `character-designer`（立体人物卡生成 · `worldbuilding` · 默认角色 `lorekeeper` · 可回写 `['knowledge_card']`）
     - `rolePosition`（`select`, 必填, 选项 `['主角', '反派', '核心搭档/女主', '导师', '关键配角']`, 默认 `'主角'`）
     - `archetype`（`text`, 必填, max 200）
     - `backgroundHint`（`textarea`, 可选, max 2000）
     - `count`（`number`, 可选, min 1, max 3, 默认 1）
  3. `world-faction-builder`（世界观与势力设定 · `worldbuilding` · 默认角色 `lorekeeper` · 可回写 `['knowledge_card', 'book_outline']`）
     - `cardCategory`（`select`, 必填, 选项 value 为 `world` / `faction` / `item` / `location` / `plot` 与中文标签，默认 `'faction'`）
     - `theme`（`text`, 必填, max 200）
     - `constraints`（`textarea`, 可选, max 2000）
     - `count`（`number`, 可选, min 1, max 3, 默认 2）
  4. `golden-finger-designer`（金手指 / 外挂系统设计 · `planning` · 默认角色 `showrunner` · 可回写 `['knowledge_card', 'book_outline']`）
     - `powerStyle`（`select`, 必填, 选项 `['系统面板', '神秘古宝', '天赋词条', '模拟推演', '特殊血脉', '自定义机制']`, 默认 `'神秘古宝'`）
     - `coreMechanic`（`textarea`, 必填, max 2000）
     - `limitation`（`textarea`, 可选, max 1000）
     - `count`（`number`, 可选, min 1, max 3, 默认 2）
  5. `plot-hook-brainstorm`（剧情冲突与章尾钩子脑暴 · `drafting` · 默认角色 `showrunner` · 可回写 `['knowledge_card', 'book_outline']`）
     - `currentSituation`（`textarea`, 必填, max 3000）
     - `conflictType`（`select`, 必填, 选项 `['打脸反转', '危机升级', '秘密揭晓', '感情拉扯', '悬念章尾钩子']`, 默认 `'危机升级'`）
     - `count`（`number`, 可选, min 1, max 5, 默认 3）
  6. `text-polish-diagnose`（片段文本质检与润色建议 · `drafting` · 默认角色 `critic` · 可回写 `['knowledge_card']`）
     - `excerpt`（`textarea`, 必填, max 6000）
     - `focus`（`select`, 必填, 选项 `['综合诊断与节奏', '去除水文与重复', '增强画面感与张力', '对话口吻强化']`, 默认 `'综合诊断与节奏'`）

### 2.3 Zod Schema 与 DTO（`packages/shared/src/schemas/toolbox.ts`）

- `toolboxFieldOptionSchema`、`toolboxFieldSchema`、`toolboxToolDefinitionSchema`、`toolboxToolsResponseSchema`
- `toolboxResultItemSchema`、`toolboxOutputSchema`
- `runToolboxRequestSchema`（`strictObject`）：
  - `toolId: toolboxToolIdSchema`
  - `bookId: z.string().uuid().nullable().optional()`
  - `role: agentRoleSchema.optional()`（省略时取工具 `defaultRole`）
  - `inputs: z.record(z.string(), z.union([z.string(), z.number()]))`
- `validateToolboxInputs(toolId, rawInputs)`：返回 `{ ok: true, data: Record<string, string | number> } | { ok: false, issues: ApiErrorIssue[] }`，逐字段校验必填、字符串长度、枚举合法性、整数范围与默认值补全，并拒绝工具未声明的多余字段。
- `toolboxRunSummarySchema` / `toolboxRunDetailSchema` / `toolboxRunListQuerySchema` / `toolboxRunListResponseSchema`
- `applyToolboxCardRequestSchema`（`strictObject`）：
  - `bookId: z.string().uuid()`
  - `itemIndex: z.number().int().min(0).max(9)`
  - `category: knowledgeCardCategorySchema.optional()`
  - `title: z.string().trim().min(1).max(200).optional()`
  - `pinned: z.boolean().optional()`
- `applyToolboxOutlineRequestSchema`（`strictObject`）：
  - `bookId: z.string().uuid()`
  - `itemIndex: z.number().int().min(0).max(9)`
  - `field: toolboxOutlineFieldSchema`
  - `mode: toolboxOutlineApplyModeSchema.default('append')`

---

## 3. 数据库表结构（`apps/server` · `0004_*.sql`）

新增第 14 张核心表 `toolbox_runs`：

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `uuid` | PK, `defaultRandom()` | 运行 ID |
| `tool_id` | `varchar(64)` | NOT NULL | 工具 ID（6 种之一） |
| `book_id` | `uuid` | NULLABLE, FK `books.id` ON DELETE SET NULL | 可选关联书籍（删书后保留历史） |
| `role` | `varchar(32)` | NOT NULL | 实际执行的写书角色 |
| `status` | `varchar(16)` | NOT NULL | `completed` / `failed` |
| `inputs_json` | `jsonb` | NOT NULL | 校验归一后的输入参数 |
| `output_json` | `jsonb` | NULLABLE | 规范化后的 `{ overview, items[] }`（失败时为 null） |
| `model_ref` | `varchar(256)` | NULLABLE | 实际调用的模型标识 |
| `input_tokens` | `integer` | NOT NULL DEFAULT 0 | 输入 Token |
| `output_tokens` | `integer` | NOT NULL DEFAULT 0 | 输出 Token |
| `estimated_cost_usd` | `numeric(12,6)` | NOT NULL DEFAULT `'0'` | 估算费用（USD） |
| `latency_ms` | `integer` | NOT NULL DEFAULT 0 | 调用耗时（毫秒） |
| `error_code` | `varchar(64)` | NULLABLE | 失败错误码 |
| `error_message` | `text` | NULLABLE | 脱敏错误摘要 |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | 创建时间 |

索引：
- `toolbox_runs_created_idx (created_at)`
- `toolbox_runs_book_created_idx (book_id, created_at)`
- `toolbox_runs_tool_created_idx (tool_id, created_at)`

---

## 4. `packages/agents` 创作工具盒引擎设计

- `packages/agents/src/prompts/toolbox.ts`：
  - `buildToolboxPrompts(input: ToolboxPromptInput)`：按 `toolId` 生成原创中文 `system` + `prompt`，若传入 `bookContext`（书名、题材、总大纲核心字段、最多前 8 张核心设定卡摘要），以清晰分节注入背景约束；明确要求模型输出 JSON 对象 `{ "overview": "...", "items": [{ "title", "summary", "content", "aliases", "tags", "suggestedCardCategory" }] }`。
  - `parseToolboxOutput(rawText, toolId, fallbackCategory?)`：
    1. 优先剥离 Markdown ` ```json ` 代码块并截取首个 JSON 对象解析；
    2. 兼容单对象字段归一化（自动清洗空别名/空标签、长度截断、非法 `suggestedCardCategory` 回退为工具推荐分类）；
    3. 若模型返回纯文本无法解析 JSON，确定性降级为 1 条完整 `item`（`title` 取工具名 + 生成结果、`content` 保留原文），绝不崩溃。
- `packages/agents/src/toolbox/run-toolbox-tool.ts`：
  - `runToolboxTool(gateway, input)`：校验 `inputs` → 构造 Prompt → 调用 `gateway.generateText({ config, role, scene: USAGE_SCENES.toolboxRun, system, prompt, temperature, maxOutputTokens, abortSignal })` → 解析结构化结果并返回 `{ output, modelRef, inputTokens, outputTokens, estimatedCostUsd, latencyMs }`。
  - 在 `packages/agents/src/index.ts` 统一导出（零 Mastra 内部类型泄露）。

---

## 5. 服务端 REST API（`apps/server/src/routes/toolbox.ts`）

| 方法 | 路径 | 行为与边界 |
|---|---|---|
| `GET` | `/api/v1/toolbox/tools` | 返回 6 个内置工具元数据目录 |
| `GET` | `/api/v1/toolbox/runs` | 分页筛选历史列表（`toolId`、`bookId`、`status`、`page`、`pageSize`） |
| `POST` | `/api/v1/toolbox/runs` | 校验 `toolId` + `validateToolboxInputs` + 可选 `bookId` 存在且未软删 + 目标角色已绑定且模型/供应商启用 → 组装可选 Book Bible 精简上下文 → 调用 `runToolboxTool` → 成功写 `completed` 返回 `201`；上游模型异常时先写脱敏 `failed` 记录再抛出规范错误码（502/429/504） |
| `GET` | `/api/v1/toolbox/runs/:runId` | 返回单条历史完整详情（含 `inputs` 与 `output`） |
| `DELETE` | `/api/v1/toolbox/runs/:runId` | 删除历史记录返回 `204`（不影响已保存设定卡/大纲） |
| `POST` | `/api/v1/toolbox/runs/:runId/apply-card` | 校验 run 存在且 `completed`、`itemIndex` 合法、目标书籍活跃 → 调用 `bookBibleRepo.createCard` → 返回 `201 KnowledgeCardDto` |
| `POST` | `/api/v1/toolbox/runs/:runId/apply-outline` | 校验 run 存在且 `completed`、`itemIndex` 合法、目标书籍活跃 → 读取现有大纲，按 `append`（空行拼接，保留其余字段）或 `replace` 写入目标字段 → 调用 `bookBibleRepo.upsertOutline` → 返回 `200 BookOutlineDto` |

---

## 6. 前端创作工具盒与全站打磨（`apps/web`）

1. **API & Store**：
   - `apps/web/src/api/toolbox.ts`（并从 `api/index.ts` 导出）
   - `apps/web/src/stores/toolbox.ts`：管理工具目录、当前选中工具、表单值、绑定书籍、执行中状态、当前结果与历史记录分页/回看/删除/一键回写。
2. **`/toolbox` 工作台（`ToolboxView.vue` + `apps/web/src/components/toolbox/`）**：
   - 三栏/两栏清晰布局：左侧按 3 大分类分组的 6 个工具卡片；主区顶部关联作品选择器 + 可选角色覆盖 + 动态 Schema 表单（`Ctrl/Cmd+Enter` 执行）；下方/右侧为结构化结果区（总览 + 每条结果卡片支持一键复制、「存为设定卡」弹窗、「写入全书大纲」弹窗），并带历史记录抽屉/侧栏支持筛选、回看与删除。
   - 当未绑定角色返回 `AGENT_ROLE_UNBOUND` 时展示友好提示与一键跳转 `/models` 按钮；成功回写设定卡/大纲后提供直达 `/books/:bookId` 链接。
   - 支持 `/toolbox?bookId=<uuid>` 查询参数自动预选关联作品。
3. **全站收官打磨**：
   - 更新 `apps/web/src/router/routes.ts` 与 `routes.test.ts`：清除所有 Change 5 占位描述，确认全站 5 大模块 100% 正式上线。
   - 更新 `apps/web/src/components/workspace/BookBiblePanel.vue`：顶部增加「创作工具盒」快捷入口，携带当前 `bookId` 跳转 `/toolbox?bookId=<bookId>`。
   - 更新 `apps/web/src/components/runtime/UsageLogsPanel.vue`：改用 `@fanxiaoshuo/shared` 导出的 `USAGE_SCENE_LABELS`，完整显示全部 7 个场景的中文名称；微调 `RuntimeView.vue` KPI 摘要同时覆盖 `runtime-smoke` 与 `novel-workflows`。
