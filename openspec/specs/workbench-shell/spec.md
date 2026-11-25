# workbench-shell Specification

## Purpose

提供「梵小说」内部创作工作台的桌面端导航外壳、浅色/暗黑双主题持久化与首屏防闪白体验，以及后端服务与基础设施运行状态的实时可视化反馈。

## Requirements

### Requirement: 桌面工作台导航与模块路由壳
The system SHALL present a desktop workbench shell branded as 「梵小说」 with a persistent sidebar navigation covering 书架（Books）、批量流水线（Workflows）、创作工具盒（Toolbox）、模型配置（Models） and 用量与状态（Usage & Health）, hosting live routes for books, writing workspace, batch workflows console, model registry, and runtime diagnostics.

#### Scenario: 访问根路径默认进入工作台
- **WHEN** 用户在浏览器打开工作台根路径 `/`
- **THEN** 系统自动重定向至默认主视图并渲染带有「梵小说」标识的侧边导航栏与顶部状态栏

#### Scenario: 访问书架与书籍写作工作区
- **WHEN** 用户点击侧边栏「书架」或打开 `/books/:bookId/:chapterId?`
- **THEN** 系统渲染完整的书架管理页或对应书籍的卷章树与章节编辑器工作区，侧边栏保持「书架」高亮

#### Scenario: 访问批量流水线控制台
- **WHEN** 用户点击侧边栏「批量流水线」或直接访问 `/workflows`
- **THEN** 系统渲染完整的批量写书流水线控制台（批次列表、新建批次向导、实时步骤进度与控制操作），侧边栏保持「批量流水线」高亮

#### Scenario: 访问尚未实现的后续阶段模块
- **WHEN** 用户点击侧边栏中属于后续变更的模块入口（创作工具盒）
- **THEN** 系统渲染对应的规范占位视图，明确说明该模块所属规划阶段，且不产生未捕获路由错误或白屏

#### Scenario: 访问未知路径
- **WHEN** 用户访问不存在的 URL 路径
- **THEN** 系统展示友好的 404 回退视图并提供一键返回工作台首页的按钮

### Requirement: 明暗双主题切换与首屏防闪白
The system SHALL support switching between light and dark themes, persist the user's choice across reloads, and apply the saved theme before initial paint so dark mode never flashes white on reload.

#### Scenario: 切换并持久化主题偏好
- **WHEN** 用户在顶部栏点击明暗主题切换开关
- **THEN** 页面整体配色立即切换为目标主题，且该偏好被持久化保存
- **AND** 刷新页面后仍保持切换后的主题

#### Scenario: 暗黑主题刷新无首屏闪白
- **WHEN** 用户已启用暗黑主题并重新加载页面
- **THEN** 页面在首次绘制前即应用暗黑根样式，不出现明显的亮色背景闪烁

### Requirement: 系统基础设施健康状态指示
The system SHALL display real-time connectivity status for the API server, PostgreSQL database, Redis broker, and background worker in the workbench interface.

#### Scenario: 所有基础设施正常在线
- **WHEN** 数据库、Redis 与后台 Worker 均处于健康状态且用户打开工作台或状态页
- **THEN** 界面以正常状态指示全部核心组件在线，并展示各组件最近一次心跳或探测延迟

#### Scenario: 任一依赖服务离线或降级
- **WHEN** 数据库、Redis 或后台 Worker 不可达
- **THEN** 状态指示器清晰标出异常组件名称与可读诊断提示，且界面其余可展示区域不崩溃
