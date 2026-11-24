# Spec Delta

## Purpose

提供「梵小说」运行期底层基础设施、PostgreSQL 与 Redis 容器化部署、统一 LLM 调用计量流水、Mastra 多 Agent 引擎初始化以及 BullMQ 异步任务队列底座，确保后续批量写书能力可靠扩展。

## ADDED Requirements

### Requirement: 本地 Docker 基础设施与数据库迁移
The system SHALL provide reproducible local infrastructure definitions for PostgreSQL with vector support and Redis, along with idempotent database schema migrations.

#### Scenario: 启动本地依赖并执行迁移
- **WHEN** 开发者启动 Docker 依赖服务并执行数据库迁移命令
- **THEN** PostgreSQL（启用 `vector` 扩展）与 Redis 均通过健康检查，且全部基础业务表创建成功
- **AND** 重复执行迁移命令保持幂等且不破坏已有数据

### Requirement: 系统健康探测接口
The system SHALL expose a health inspection endpoint that actively checks PostgreSQL connectivity, Redis connectivity, and recent background worker heartbeat status.

#### Scenario: 全链路健康检查通过
- **WHEN** 客户端请求系统健康接口且 PostgreSQL、Redis 均可连通且 Worker 在心跳有效期（30 秒内）上报过活跃状态
- **THEN** 接口返回 200 及各子系统 `ok` 状态与探测延迟

#### Scenario: 局部依赖不可用时返回降级详情
- **WHEN** 客户端请求系统健康接口而 Redis 或 Worker 离线
- **THEN** 接口返回明确的降级状态与对应组件失败原因，而非无上下文的 500 报错

### Requirement: 统一 LLM 调用网关与用量成本落盘
The system SHALL route all model invocations through a single gateway abstraction that records model, agent role, prompt/completion token counts, estimated cost, latency, and outcome into persistent usage logs.

#### Scenario: 每次成功调用自动记录 Token 与估算费用
- **WHEN** 系统通过统一网关完成一次模型调用（包括模型连通性测试或队列冒烟任务）
- **THEN** 系统在用量日志表中追加一条不可篡改的记录，包含角色标识、模型标识、输入/输出 Token 数、按单价计算的估算费用、耗时及成功状态

#### Scenario: 调用失败同样记录审计日志
- **WHEN** 统一网关向模型上游发起请求发生超时或接口报错
- **THEN** 系统追加一条失败状态的用量日志，包含错误分类与脱敏错误摘要，便于排查与统计失败率

### Requirement: 用量日志查询与成本汇总
The system SHALL provide paginated query access to recorded LLM usage logs along with aggregated total tokens and estimated spend across a selectable time range.

#### Scenario: 查看最近用量明细与汇总
- **WHEN** 用户在工作台打开「用量与状态」页面或请求用量日志接口
- **THEN** 系统按时间倒序返回调用明细列表，并返回筛选区间内的总请求数、总 Token 数与总估算费用

### Requirement: Mastra 与 BullMQ 异步队列全链路冒烟任务
The system SHALL run a background worker connected to Redis queues and the Mastra runtime capable of executing durable async smoke jobs, publishing status updates, and retrying transient failures.

#### Scenario: 触发队列冒烟任务完成全链路验证
- **WHEN** 用户在「用量与状态」页或通过 API 触发一次 Agent 运行时冒烟测试任务
- **THEN** API 将任务入队并返回任务 ID，后台 Worker 消费任务并经 Mastra 运行时处理后回写完成状态与耗时
- **AND** 前端能够通过状态接口或实时事件观察到任务从排队、运行中变为已完成

#### Scenario: 队列任务异常具备受控重试与上限保护
- **WHEN** 后台任务执行遇到瞬时错误
- **THEN** 队列按指数退避策略自动重试至最大次数上限；超过上限后标记为失败并保留可诊断错误信息，不产生无限死循环
