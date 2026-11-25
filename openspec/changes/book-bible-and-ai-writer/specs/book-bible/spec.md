# Spec Delta

## Purpose

提供「梵小说」的作品级长篇记忆层（Book Bible），涵盖全书总大纲、结构化设定卡、章节细纲与剧情摘要（含 AI 一键提炼），以及面向 AI 写作的记忆召回与 Token 预算上下文组装预览能力。

## ADDED Requirements

### Requirement: 全书总大纲与写作规范管理
The system SHALL allow users to view and save a structured book-level outline covering main plot, world setting overview, style guide and taboos, and ending plan for every active book.

#### Scenario: 读取尚未填写总大纲的新书
- **WHEN** 用户打开一本新建书籍的总大纲视图并发起查询
- **THEN** 系统返回带有空文本默认字段与 `updatedAt: null` 的总大纲结构，不返回 404 错误

#### Scenario: 保存并回显全书总大纲
- **WHEN** 用户编辑总大纲的主线剧情、世界观概览、文风禁忌或结局规划并点击保存
- **THEN** 系统持久化该书总大纲并更新 `updatedAt`，再次打开本书时完整回显已保存内容

### Requirement: 结构化设定卡增删改查、筛选与常驻置顶
The system SHALL allow users to create, list, filter, update, pin/unpin, and delete structured knowledge cards per book across six categories (`character`, `world`, `faction`, `item`, `foreshadowing`, `timeline`), storing title, summary, detailed content, aliases, tags, and pinned status.

#### Scenario: 创建人物设定卡并按分类与关键字筛选
- **WHEN** 用户在某本书下新建一张 `character` 类别设定卡，填写名称、摘要、详细设定、别名列表、标签并设为常驻置顶
- **THEN** 系统持久化该卡片并在设定卡列表中返回完整元信息（不含原始向量数组），支持按分类、常驻状态及名称/别名/摘要关键字筛选命中

#### Scenario: 切换设定卡常驻状态或删除设定卡
- **WHEN** 用户更新某张设定卡的 `pinned` 标志、编辑内容或删除该设定卡
- **THEN** 系统原子更新或移除该记录，跨书访问不存在或归属其他书籍的 `cardId` 时返回 `404 KNOWLEDGE_CARD_NOT_FOUND`

### Requirement: 章节细纲与剧情摘要管理及 AI 提炼
The system SHALL maintain a per-chapter brief containing chapter outline, plot summary, key events, present characters, and source (`manual` or `ai`), supporting both manual editing and one-click extraction from chapter text via the `lorekeeper` agent role.

#### Scenario: 手工保存本章细纲与剧情摘要
- **WHEN** 用户在写作工作区编辑当前章节的细纲、摘要、关键事件或出场人物并保存
- **THEN** 系统以 `source: 'manual'` 持久化该章记忆记录并回显更新时间

#### Scenario: 调用 Lorekeeper 从正文一键提炼摘要
- **WHEN** 用户对包含非空正文的章节触发「AI 提炼摘要」
- **THEN** 系统通过绑定 `lorekeeper` 角色的 `ModelGateway`（场景 `lore-extract`）提取剧情摘要、关键事件与出场人物，记录一条 `llm_usage_logs` 用量日志，并在保存模式下保留原有本章细纲、以 `source: 'ai'` 落盘更新摘要

#### Scenario: 对空正文或未绑定 Lorekeeper 角色触发摘要提炼
- **WHEN** 当前章节正文为空白，或 `lorekeeper` 角色尚未绑定可用模型
- **THEN** 系统拒绝调用上游模型并返回结构化错误（`400 AI_EMPTY_CONTEXT` 或 `409 AGENT_ROLE_UNBOUND` / 模型停用错误），不写入脏摘要数据

### Requirement: 记忆召回与 Token 预算上下文组装预览
The system SHALL assemble a deterministic, token-budgeted writing context packet for any active chapter from the book outline, pinned/explicitly selected/keyword-recalled knowledge cards, recent preceding chapter summaries, previous chapter ending excerpt, and current chapter draft, and expose a preview endpoint prior to generation.

#### Scenario: 按优先级召回设定卡并预览上下文预算
- **WHEN** 客户端请求某章节的上下文组装预览并指定写作动作、指令及可选手动勾选卡片 ID 列表
- **THEN** 系统按「手动勾选 > 常驻置顶 > 名称与别名关键词相关性打分」顺序召回设定卡，附带前序最近 N 章摘要与上一章尾部正文，返回各分段估算 Token 数、总估算 Token、被纳入卡片清单与提示词预览

#### Scenario: 超出 Token 预算时执行确定性裁剪
- **WHEN** 书籍总大纲、设定卡与前情摘要总量超过请求的 `maxContextTokens` 上限
- **THEN** 系统在保留系统约束、当前章信息、总大纲与常驻核心卡的前提下，按既定优先级依次裁剪低相关性设定卡、较远前情摘要与上一章尾部长度，并在响应中将 `truncated` 标记为 `true`
