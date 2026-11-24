import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalized,
} from 'vue-router';
import { routes } from './routes';

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

const DEFAULT_TITLE = '梵小说 · 内部批量创作台';

function resolveTitle(to: RouteLocationNormalized): string {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  return title.length > 0 ? `${title} · 梵小说` : DEFAULT_TITLE;
}

router.afterEach((to) => {
  if (typeof document !== 'undefined') {
    document.title = resolveTitle(to);
  }
});

export { routes } from './routes';
