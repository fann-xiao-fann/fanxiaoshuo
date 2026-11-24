# Spec Delta

## Purpose

提供多 LLM 上游供应商（含 OpenAI-compatible 中转站）与模型目录的配置管理、API 密钥安全脱敏、写书多 Agent 角色默认模型槽位绑定，以及真实调用连通性验证能力。

## ADDED Requirements

### Requirement: LLM 供应商配置增删改查
The system SHALL allow users to create, list, update, enable/disable, and delete LLM provider configurations including display name, protocol type, base URL, and API key.

#### Scenario: 新增 OpenAI-compatible 供应商
- **WHEN** 用户提交有效的供应商名称、OpenAI-compatible 协议类型、合法 Base URL 与非空 API Key
- **THEN** 系统持久化该供应商记录并返回创建结果
- **AND** 供应商列表中可查看该记录且默认处于启用状态

#### Scenario: 提交非法配置被拒绝
- **WHEN** 用户提交空名称、格式非法的 Base URL 或缺失 API Key 的新增请求
- **THEN** 系统返回结构化校验错误并指出具体字段原因，不写入任何脏数据

### Requirement: API 密钥加密落库与响应脱敏
The system SHALL encrypt provider API keys at rest and MUST never return plaintext API keys in API responses, frontend state, or application logs.

#### Scenario: 查询供应商列表时脱敏展示密钥
- **WHEN** 客户端请求供应商列表或单条详情
- **THEN** 响应仅返回掩码指纹（如保留前 3 位与后 4 位字符），不返回完整明文 API Key

#### Scenario: 更新供应商时保留已有密钥
- **WHEN** 用户编辑供应商名称或 Base URL 但留空 API Key 字段
- **THEN** 系统保留原加密密钥不变并仅更新其他修改字段

### Requirement: 模型目录与单价管理
The system SHALL allow users to register multiple models under an existing provider with model identifier, context window metadata, and input/output unit pricing per million tokens.

#### Scenario: 在供应商下注册模型及价格
- **WHEN** 用户在已创建的供应商下添加模型（如 `modelId`、展示名、输入单价与输出单价）
- **THEN** 系统保存该模型记录并允许将其选为写书 Agent 角色的绑定目标

#### Scenario: 删除仍被角色绑定的模型
- **WHEN** 用户尝试删除当前已被某个写书 Agent 角色绑定的模型
- **THEN** 系统拒绝删除并返回明确冲突提示，要求先解除或切换角色绑定

### Requirement: 写书多 Agent 角色模型槽位绑定
The system SHALL maintain default model bindings for the four core writing agent roles (`showrunner`, `lorekeeper`, `writer`, `critic`) with per-role temperature and max-token overrides.

#### Scenario: 为不同写作角色绑定不同模型
- **WHEN** 用户将 `showrunner` 绑定到强推理模型、将 `writer` 绑定到高性价比长文模型、将 `lorekeeper` 绑定到快速摘要模型并保存
- **THEN** 系统持久化各角色绑定配置，后续任意调用按角色解析对应模型与参数

#### Scenario: 查询角色路由配置
- **WHEN** 用户打开模型配置中心的角色路由面板
- **THEN** 系统返回全部四个固定角色的当前绑定状态（含未绑定提示）及对应所属供应商状态

### Requirement: 模型一键连通性测试
The system SHALL provide a connectivity test action for any configured model that executes a minimal live completion request through the unified gateway and reports success, latency, and token usage.

#### Scenario: 模型连通性测试成功
- **WHEN** 用户触发某已启用模型的「测通」操作且上游服务响应正常
- **THEN** 系统返回成功状态、响应文本预览、往返延迟毫秒数与本次消耗 Token 数，并同步写入一条用量日志

#### Scenario: 上游密钥错误或网络超时
- **WHEN** 用户触发「测通」操作但上游返回鉴权失败或超时
- **THEN** 系统返回明确的脱敏错误原因（不含明文 Key）与 HTTP/错误码分类，不导致后端进程崩溃
