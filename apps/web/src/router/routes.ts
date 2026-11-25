import type { RouteRecordRaw } from 'vue-router';

/** 侧边导航元信息（顺序即工作台信息的阅读顺序）。 */
export const NAV_ITEMS = [
  {
    key: '/books',
    label: '书架',
    caption: 'Books',
    description: '书库、卷章树与正文编辑',
  },
  {
    key: '/workflows',
    label: '批量流水线',
    caption: 'Workflows',
    description: '多 Agent 批量成文、审稿返工与实时进度控制台',
  },
  {
    key: '/toolbox',
    label: '创作工具盒',
    caption: 'Toolbox',
    description: '设定抽取、灵感扩写与文本工具（Change 5 规划）',
  },
  {
    key: '/models',
    label: '模型配置',
    caption: 'Models',
    description: '供应商、模型目录与写书角色路由',
  },
  {
    key: '/runtime',
    label: '用量与状态',
    caption: 'Runtime',
    description: '基础设施诊断、冒烟任务与 Token 成本账本',
  },
] as const;

export type NavKey = (typeof NAV_ITEMS)[number]['key'];

/** 根路径默认主视图：书架（写作者打开工作台即直达作品列表）。 */
export const DEFAULT_ROUTE_PATH: NavKey = '/books';

export interface PageMeta {
  title: string;
  description: string;
  eyebrow: string;
  /** 对应侧边导航 key；占位页与完整页均设置，404 不设置。 */
  navKey?: NavKey;
}

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/layouts/WorkbenchLayout.vue'),
    children: [
      {
        path: '',
        redirect: DEFAULT_ROUTE_PATH,
      },
      {
        path: 'books',
        name: 'books',
        component: () => import('@/views/BooksView.vue'),
        meta: {
          title: '书架',
          description: '书库总览、卷章结构与整本导出',
          eyebrow: '书库',
          navKey: '/books',
        } satisfies PageMeta,
      },
      {
        path: 'books/:bookId/:chapterId?',
        name: 'book-workspace',
        component: () => import('@/views/BookWorkspaceView.vue'),
        meta: {
          title: '写作工作区',
          description: '卷章目录树、TipTap 长文编辑器与历史版本快照',
          eyebrow: '书库',
          navKey: '/books',
        } satisfies PageMeta,
      },
      {
        path: 'workflows',
        name: 'workflows',
        component: () => import('@/views/WorkflowsView.vue'),
        meta: {
          title: '批量流水线',
          description: '多 Agent 批量成文、审稿返工闭环与实时进度控制台',
          eyebrow: '运行期',
          navKey: '/workflows',
        } satisfies PageMeta,
      },
      {
        path: 'toolbox',
        name: 'toolbox',
        component: () => import('@/views/ToolboxView.vue'),
        meta: {
          title: '创作工具盒',
          description: '设定抽取、灵感扩写与文本辅助工具（Change 5）',
          eyebrow: '创作',
          navKey: '/toolbox',
        } satisfies PageMeta,
      },
      {
        path: 'models',
        name: 'models',
        component: () => import('@/views/ModelsView.vue'),
        meta: {
          title: '模型配置中心',
          description: '维护上游供应商、模型目录与四位写书 Agent 的默认模型路由',
          eyebrow: '配置',
          navKey: '/models',
        } satisfies PageMeta,
      },
      {
        path: 'runtime',
        name: 'runtime',
        component: () => import('@/views/RuntimeView.vue'),
        meta: {
          title: '用量与状态',
          description: '基础设施实时诊断、Mastra + BullMQ 冒烟验证与 Token 成本账本',
          eyebrow: '运行期',
          navKey: '/runtime',
        } satisfies PageMeta,
      },
      {
        path: ':pathMatch(.*)*',
        name: 'not-found',
        component: () => import('@/views/NotFoundView.vue'),
        meta: {
          title: '页面未找到',
          description: '请求的路径不存在',
          eyebrow: '404',
        } satisfies PageMeta,
      },
    ],
  },
];

export function findNavItem(key: string): (typeof NAV_ITEMS)[number] | undefined {
  return NAV_ITEMS.find((item) => item.key === key);
}
