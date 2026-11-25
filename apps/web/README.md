# @fanxiaoshuo/web — 梵小说工作台前端

Vue 3 + TypeScript + Vite + Pinia + Vue Router + Naive UI 实现的「梵小说 · 内部批量创作台」。
本包仅依赖 `@fanxiaoshuo/shared`（Zod 契约与 DTO），不直接访问任何上游模型接口。

## 开发

在仓库根目录执行：

```bash
pnpm install
pnpm --filter @fanxiaoshuo/web dev
```

默认开发地址 `http://127.0.0.1:5173`，可通过根 `.env` 的 `WEB_PORT` 覆盖。
`/api` 由 Vite dev proxy 转发到 `http://127.0.0.1:${API_PORT || 3001}`；
SSE 端点 `/api/v1/runtime/events` 已关闭代理超时、禁用压缩缓冲并覆写 `cache-control`。

```bash
pnpm --filter @fanxiaoshuo/web typecheck
pnpm --filter @fanxiaoshuo/web test
pnpm --filter @fanxiaoshuo/web build
```

## 目录

```text
src/
  api/         强类型 API 客户端（Zod 校验响应、统一 ApiClientError）
  components/  工作台组件：健康徽章、模型配置、运行期面板、书架卡片与写作工作区（卷章树 / TipTap 编辑器 / 快照抽屉）
  layouts/     WorkbenchLayout：可折叠侧边导航 + 顶部状态栏
  router/      路由壳、5 个导航入口、书架与 /books/:bookId/:chapterId? 写作工作区、404 回退
  stores/      theme / health / registry / books / book-workspace（Pinia）
  styles/      明暗双主题 CSS 变量与工作台样式
  utils/       数值、金额、时间与角色名格式化、字数格式化、TipTap 文档 ↔ 纯文本转换、保存状态文案
  views/       书架、写作工作区、模型配置、用量与状态、两个占位页、404
```

## 主题与首屏防闪白

- 偏好键：`localStorage['fx.ui.theme']`（`light` / `dark`）。
- `index.html` 的同步内联脚本在首绘前读取偏好（缺省跟随系统），为 `<html>` 挂 `dark` 类并写入深色底色变量，杜绝刷新闪白。
- `useThemeStore` 负责切换、持久化、同步 `document.documentElement` 的 class / `data-theme` / `color-scheme`，并驱动 Naive UI `<n-config-provider :theme>`。

## 契约说明

- 所有请求与响应类型来自 `@fanxiaoshuo/shared`，前端不重复维护 DTO。
- 为便于单包构建与测试，Vite / Vitest / tsconfig 均将 `@fanxiaoshuo/shared` 别名到 `packages/shared/src/index.ts`，避免依赖其 `dist` 产物。
- 冒烟任务 `POST /api/v1/runtime/smoke-jobs` 的共享契约只包含 `invokeModel` / `note`；`live` 模式由服务端按角色路由解析模型，前端不擅自扩展请求字段。
