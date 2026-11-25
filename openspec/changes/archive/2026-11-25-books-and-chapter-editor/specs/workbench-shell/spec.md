# Spec Delta

## MODIFIED Requirements

### Requirement: 桌面工作台导航与模块路由壳
The system SHALL present a desktop workbench shell branded as 「梵小说」 with a persistent sidebar navigation covering 书架（Books）、批量流水线（Workflows）、创作工具盒（Toolbox）、模型配置（Models） and 用量与状态（Usage & Health）, hosting live routes for books, writing workspace, model registry, and runtime diagnostics.

#### Scenario: 访问根路径默认进入工作台
- **WHEN** 用户在浏览器打开工作台根路径 `/`
- **THEN** 系统自动重定向至默认主视图并渲染带有「梵小说」标识的侧边导航栏与顶部状态栏

#### Scenario: 访问书架与书籍写作工作区
- **WHEN** 用户点击侧边栏「书架」或打开 `/books/:bookId/:chapterId?`
- **THEN** 系统渲染完整的书架管理页或对应书籍的卷章树与章节编辑器工作区，侧边栏保持「书架」高亮

#### Scenario: 访问尚未实现的后续阶段模块
- **WHEN** 用户点击侧边栏中属于后续变更的模块入口（批量流水线或创作工具盒）
- **THEN** 系统渲染对应的规范占位视图，明确说明该模块所属规划阶段，且不产生未捕获路由错误或白屏

#### Scenario: 访问未知路径
- **WHEN** 用户访问不存在的 URL 路径
- **THEN** 系统展示友好的 404 回退视图并提供一键返回工作台首页的按钮
