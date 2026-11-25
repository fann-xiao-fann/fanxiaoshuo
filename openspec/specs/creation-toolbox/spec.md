# creation-toolbox Specification

## Purpose

提供「梵小说」Schema 驱动的创作工具盒（Creation Toolbox），内置书名简介策划、人物卡生成、世界观/势力设定、金手指系统设计、剧情冲突与钩子脑暴、片段文本质检与润色 6 大单点提效工具，支持关联作品上下文、持久化执行历史、统一网关计量，以及一键沉淀结果到 Book Bible 设定卡与全书总大纲。

## Requirements

### Requirement: 声明式工具目录与 Schema 驱动输入校验
The system SHALL expose a declarative catalog of 6 built-in creation tools (`book-pitch`, `character-designer`, `world-faction-builder`, `golden-finger-designer`, `plot-hook-brainstorm`, `text-polish-diagnose`) grouped into `planning`, `worldbuilding`, and `drafting`, complete with field schemas, default agent roles, and supported apply targets, and MUST validate tool inputs against the tool's field schema before invoking any model.

#### Scenario: 获取完整工具目录用于动态渲染表单
- **WHEN** 客户端请求 `GET /api/v1/toolbox/tools`
- **THEN** 服务端返回 6 个内置工具的完整元数据列表（含 `id`、`name`、`category`、`summary`、`defaultRole`、`fields` 表单字段定义与 `applyTargets`），且字段定义可直接驱动前端表单渲染而无需硬编码

#### Scenario: 工具输入缺失必填项或超范围时拒绝执行
- **WHEN** 用户向 `POST /api/v1/toolbox/runs` 提交不存在的 `toolId` 或缺少该工具的必填字段（如 `character-designer` 缺少 `archetype`）
- **THEN** 服务端在调用模型与写入记录之前拒绝请求，分别返回 `404 TOOLBOX_TOOL_NOT_FOUND` 或 `400 VALIDATION_ERROR`，且不产生脏历史记录或模型消耗

### Requirement: 统一网关执行、可选作品上下文注入与结构化结果解析
The system SHALL execute toolbox tools through `packages/agents` and `ModelGateway` using the bound model of the selected writing role (defaulting to the tool's `defaultRole`), optionally injecting the associated book's outline and core knowledge cards as grounding context, persisting `llm_usage_logs` under scene `toolbox-run`, and normalizing outputs into a structured `{ overview, items[] }` format with deterministic plain-text fallback.

#### Scenario: 关联作品上下文执行人物卡生成并落盘计量
- **WHEN** 用户选择一本活跃书籍并提交 `character-designer` 工具执行请求，且目标角色已绑定可用模型
- **THEN** 服务端读取该书总大纲与核心设定卡注入 Prompt，经 `ModelGateway` 发起单次生成并记录 `llm_usage_logs`（`scene = 'toolbox-run'`），将规范化后的 `{ overview, items[] }` 与 Token/估算费用/耗时持久化至 `toolbox_runs` 并返回 `201` 完整详情

#### Scenario: 目标写书角色未绑定模型时拒绝执行
- **WHEN** 用户执行某一工具但默认角色（或指定的覆盖角色）未在模型配置中心绑定可用模型，或模型/供应商已停用
- **THEN** 服务端返回 `409` 规范错误（`AGENT_ROLE_UNBOUND` / `PROVIDER_DISABLED` / `MODEL_DISABLED`），不写入运行记录

#### Scenario: 上游模型返回非严格 JSON 或调用失败时安全收敛
- **WHEN** 模型输出包含 Markdown 代码块或普通文本而非纯 JSON
- **THEN** 解析器安全抽取或降级为结构化单条结果，不抛出未捕获解析异常
- **AND** 若上游模型调用失败（如鉴权失败、限流或超时），服务端记录脱敏错误摘要到 `toolbox_runs`（`status = 'failed'`，绝不泄露明文 API Key）并返回对应规范错误响应

### Requirement: 一键回写结果至 Book Bible 设定卡与全书总大纲
The system SHALL allow users to apply any structured output item from a completed toolbox run directly into a target active book's knowledge cards (`POST /api/v1/toolbox/runs/:runId/apply-card`) or book outline (`POST /api/v1/toolbox/runs/:runId/apply-outline`).

#### Scenario: 将工具产出条目一键保存为作品设定卡
- **WHEN** 用户在已完成的工具运行结果中选取第 `itemIndex` 项，指定目标书籍与分类（默认取 `suggestedCardCategory`，可覆盖）提交 `POST /api/v1/toolbox/runs/:runId/apply-card`
- **THEN** 服务端在 `knowledge_cards` 中创建对应设定卡（完整写入标题、摘要、正文、别名、标签与置顶状态）并返回 `201` 设定卡详情，该设定卡立即可在书籍 Book Bible 与后续 AI 写作召回中生效

#### Scenario: 将工具产出条目一键追加或替换写入全书总大纲
- **WHEN** 用户选取结果条目并指定目标书籍、大纲字段（`mainPlot` / `worldSetting` / `styleGuide` / `endingPlan`）及写入模式（`append` / `replace`）提交 `POST /api/v1/toolbox/runs/:runId/apply-outline`
- **THEN** 服务端更新该书 `book_outlines` 的目标字段（`append` 模式保留原内容并以空行拼接，不破坏其余 3 个大纲字段）并返回 `200` 最新全书总大纲

#### Scenario: 条目索引越界或运行未成功时拒绝回写
- **WHEN** 用户对 `failed` 状态的运行记录或越界的 `itemIndex` 发起回写请求
- **THEN** 服务端拒绝请求并返回 `400 TOOLBOX_ITEM_OUT_OF_RANGE`

### Requirement: 持久化工具运行历史与创作工具盒交互工作台
The system SHALL persist toolbox execution history with pagination and filtering (`toolId`, `bookId`, `status`), support deleting history entries without affecting already-saved knowledge cards or outlines, and provide a live `/toolbox` workbench interface with dynamic schema forms, structured result cards, quick apply dialogs, and keyboard-triggered execution.

#### Scenario: 浏览、筛选与删除创作工具盒历史记录
- **WHEN** 用户在 `/toolbox` 打开历史面板，按工具类型或关联作品筛选历史运行，点击某条历史重新回看结果，或删除不再需要的历史记录
- **THEN** 系统通过 `GET /api/v1/toolbox/runs`、`GET /api/v1/toolbox/runs/:runId` 与 `DELETE /api/v1/toolbox/runs/:runId` 正确加载与清理历史记录，且删除历史不会影响此前已保存到 Book Bible 的设定卡或总大纲
