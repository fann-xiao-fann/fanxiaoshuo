# ai-chapter-writer Specification

## Purpose

提供「梵小说」编辑器内的流式 AI 章节写作能力（续写、扩写、改写、润色），统一经由 `ModelGateway` 与写书角色路由执行，确保实时流式反馈、可随时中止、完整 Token 与费用审计落盘，以及写入正文前的 `source: 'ai'` 历史快照自动留底。

## Requirements

### Requirement: 章节内流式 AI 写作与四种核心动作
The system SHALL support streaming AI writing for an active chapter across four actions (`continue`, `expand`, `rewrite`, `polish`) over `POST` Server-Sent Events using the resolved `writer` (or requested) agent role binding and assembled Book Bible context.

#### Scenario: 发起续写请求并接收实时 SSE 增量流
- **WHEN** 用户在编辑器右侧 AI 助手输入可选写作指令并触发「续写（continue）」
- **THEN** 后端验证角色模型绑定并组装上下文后返回 `text/event-stream`，依次推送 `start` 帧、若干 `delta` 增量文本帧与包含 Token/估算费用/耗时/`usageLogId` 的 `done` 帧
- **AND** 前端助手预览区实时逐段展示生成正文，期间不自动覆盖编辑器已有正文

#### Scenario: 针对选中文本执行扩写、改写或润色
- **WHEN** 用户在编辑器中选中一段正文并触发 `expand`、`rewrite` 或 `polish`
- **THEN** 请求携带 `selectedText` 与动作类型，组装的提示词明确聚焦该选区并遵守本书总大纲与已召回设定卡约束；若 `expand`/`rewrite`/`polish` 既无选区也无任何章节正文，系统返回 `400 AI_EMPTY_CONTEXT`

#### Scenario: 写书角色未绑定或所绑模型已停用
- **WHEN** `writer`（或指定角色）未在模型配置中心绑定模型，或其绑定供应商/模型已被停用
- **THEN** 后端在建立 SSE 流之前直接返回规范 JSON 错误（`409 AGENT_ROLE_UNBOUND` / `PROVIDER_DISABLED` / `MODEL_DISABLED`），前端清晰提示原因并提供快捷入口前往 `/models`

### Requirement: 流式生成中止、错误脱敏与统一用量审计
The system SHALL allow users to cancel an in-flight AI writing stream at any time, sanitize all upstream errors so API keys are never leaked, and persist every completed or failed generation call in `llm_usage_logs`.

#### Scenario: 用户点击停止生成中止流式请求
- **WHEN** 流式生成进行中用户点击「停止生成」或客户端主动断开连接
- **THEN** 前端中止 `fetch` 请求并保留已接收的部分预览文本，服务端立即调用 `ModelGateway` 流关闭句柄终止上游请求，不产生未捕获异常

#### Scenario: 上游调用成功或失败均落盘脱敏审计日志
- **WHEN** 一次章内 AI 写作流正常完成或上游返回鉴权/限流/超时错误
- **THEN** 系统均经由 `ModelGateway` 向 `llm_usage_logs` 写入一条带角色、模型快照、`scene: 'chapter-write'`、Token 消耗、估算费用与状态的审计记录；错误场景推送 `error` SSE 帧且错误信息绝不包含任何明文 API Key

### Requirement: 带自动快照留底与乐观锁的原子 AI 正文应用
The system SHALL require explicit user confirmation to apply AI-generated text into a chapter (`append`, `replace_all`, or `replace_selection`) through an atomic endpoint that enforces optimistic version concurrency and creates an immutable `source: 'ai'` backup revision before mutating chapter content.

#### Scenario: 确认应用 AI 生成内容并自动生成 AI 留底快照
- **WHEN** 用户在预览区确认将 AI 生成结果「追加到文末」「替换选中片段」或「替换全文」，客户端携带章节当前 `expectedVersion` 调用原子应用接口
- **THEN** 后端在单一事务内先将应用前的当前章节正文留底为一条 `source: 'ai'` 的不可变历史快照，再持久化合并后的新正文、服务端重算字数并将章节 `version` 递增 1 返回
- **AND** 前端立即同步编辑器正文与最新版本号，历史版本列表中立即可见该条「AI 生成」留底快照且支持一键回滚

#### Scenario: 应用 AI 正文时章节版本号已过期
- **WHEN** 客户端提交 AI 正文应用请求时 `expectedVersion` 小于数据库当前版本
- **THEN** 后端拒绝修改且不写入脏快照，返回 `409 CHAPTER_VERSION_CONFLICT` 及服务端最新版本号，避免覆盖较新的人工或后台改动
