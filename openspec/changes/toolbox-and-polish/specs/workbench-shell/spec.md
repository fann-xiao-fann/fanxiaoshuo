# Spec Delta

## MODIFIED Requirements

### Requirement: 桌面工作台导航与模块路由壳
The system SHALL present a desktop workbench shell branded as 「梵小说」 with a persistent sidebar navigation covering 书架（Books）、批量流水线（Workflows）、创作工具盒（Toolbox）、模型配置（Models） and 用量与状态（Usage & Health）, hosting live routes for all five modules with zero placeholder views remaining, cross-module deep links, and unified usage scene labeling.

#### Scenario: 访问根路径默认进入工作台
- **WHEN** 用户在浏览器打开工作台根路径 `/`
- **THEN** 系统自动重定向至默认主视图并渲染带有「梵小说」标识的侧边导航栏与顶部状态栏

#### Scenario: 访问书架与书籍写作工作区
- **WHEN** 用户点击侧边栏「书架」或打开 `/books/:bookId/:chapterId?`
- **THEN** 系统渲染完整的书架管理页或对应书籍的卷章树与章节编辑器工作区，侧边栏保持「书架」高亮，且设定集面板提供一键携带当前 `bookId` 跳转至创作工具盒的快捷入口

#### Scenario: 访问批量流水线控制台
- **WHEN** 用户点击侧边栏「批量流水线」或直接访问 `/workflows`
- **THEN** 系统渲染完整的批量写书流水线控制台（批次列表、新建批次向导、实时步骤进度与控制操作），侧边栏保持「批量流水线」高亮

#### Scenario: 访问创作工具盒并支持携带书籍上下文进入
- **WHEN** 用户点击侧边栏「创作工具盒」或通过 `/toolbox?bookId=<id>` 访问
- **THEN** 系统渲染完整的 Schema 驱动创作工具盒工作台（工具目录、动态表单、结果卡片、一键回写设定集/大纲与历史记录），若 URL 携带合法 `bookId` 则自动预选该作品上下文，侧边栏保持「创作工具盒」高亮且不再展示任何规划占位页

#### Scenario: 用量账本完整展示全链路 7 个业务场景标签
- **WHEN** 用户在 `/runtime` 用量账本查看或筛选历史调用记录
- **THEN** 场景列与筛选下拉框均以中文标签覆盖全部 7 个业务场景（一键测通、冒烟任务、章节成文、设定抽取、审稿质检、细纲规划、创作工具盒）

#### Scenario: 访问尚未实现的后续阶段模块
- **WHEN** 用户依次访问侧边栏全部五个主导航入口（书架、批量流水线、创作工具盒、模型配置、用量与状态）
- **THEN** 五大模块均渲染完整正式业务视图，不再呈现规划占位页，且不产生未捕获路由错误或白屏

#### Scenario: 访问未知路径
- **WHEN** 用户访问不存在的 URL 路径
- **THEN** 系统展示友好的 404 回退视图并提供一键返回工作台首页的按钮
