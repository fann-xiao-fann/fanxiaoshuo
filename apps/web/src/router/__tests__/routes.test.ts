import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { DEFAULT_ROUTE_PATH, NAV_ITEMS, routes } from '@/router/routes';

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  });
}

describe('工作台路由壳', () => {
  it('根路径重定向到默认主视图 /models', async () => {
    const router = createTestRouter();
    await router.push('/');
    await router.isReady();

    expect(DEFAULT_ROUTE_PATH).toBe('/models');
    expect(router.currentRoute.value.fullPath).toBe('/models');
    expect(router.currentRoute.value.name).toBe('models');
  });

  it('五个侧边导航入口均解析到已注册路由', () => {
    const router = createTestRouter();
    const keys = NAV_ITEMS.map((item) => item.key);

    expect(keys).toEqual(['/books', '/workflows', '/toolbox', '/models', '/runtime']);

    for (const key of keys) {
      const resolved = router.resolve(key);
      expect(resolved.name).toBeDefined();
      expect(resolved.matched.length).toBeGreaterThan(0);
    }
  });

  it('占位页保留对应导航 key 与标题', async () => {
    const router = createTestRouter();
    await router.push('/books');

    expect(router.currentRoute.value.name).toBe('books');
    expect(router.currentRoute.value.meta.navKey).toBe('/books');
    expect(router.currentRoute.value.meta.title).toBe('书架');
  });

  it('未知路径命中 404 回退路由而非白屏', async () => {
    const router = createTestRouter();
    await router.push('/not-exist/deep/path');

    expect(router.currentRoute.value.name).toBe('not-found');
    expect(router.currentRoute.value.meta.title).toBe('页面未找到');
  });

  it('四项完整能力页面已注册（models / runtime / 三个占位之一）', () => {
    const router = createTestRouter();
    expect(router.resolve('/models').name).toBe('models');
    expect(router.resolve('/runtime').name).toBe('runtime');
    expect(router.resolve('/workflows').name).toBe('workflows');
    expect(router.resolve('/toolbox').name).toBe('toolbox');
  });
});
