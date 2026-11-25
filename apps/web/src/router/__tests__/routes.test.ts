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
  it('根路径重定向到默认主视图 /books', async () => {
    const router = createTestRouter();
    await router.push('/');
    await router.isReady();

    expect(DEFAULT_ROUTE_PATH).toBe('/books');
    expect(router.currentRoute.value.fullPath).toBe('/books');
    expect(router.currentRoute.value.name).toBe('books');
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

  it('书架路由挂载 navKey 与标题', async () => {
    const router = createTestRouter();
    await router.push('/books');

    expect(router.currentRoute.value.name).toBe('books');
    expect(router.currentRoute.value.meta.navKey).toBe('/books');
    expect(router.currentRoute.value.meta.title).toBe('书架');
  });

  it('书籍写作工作区支持仅 bookId 与 bookId + chapterId 两种地址', async () => {
    const router = createTestRouter();
    const bookId = '11111111-1111-4111-8111-111111111111';
    const chapterId = '22222222-2222-4222-8222-222222222222';

    const withBook = router.resolve(`/books/${bookId}`);
    expect(withBook.name).toBe('book-workspace');
    expect(withBook.meta.navKey).toBe('/books');
    expect(withBook.params.bookId).toBe(bookId);
    expect(withBook.params.chapterId).toBeUndefined();

    const withChapter = router.resolve(`/books/${bookId}/${chapterId}`);
    expect(withChapter.name).toBe('book-workspace');
    expect(withChapter.meta.navKey).toBe('/books');
    expect(withChapter.params.bookId).toBe(bookId);
    expect(withChapter.params.chapterId).toBe(chapterId);

    await router.push(`/books/${bookId}/${chapterId}`);
    expect(router.currentRoute.value.name).toBe('book-workspace');
  });

  it('后续阶段的两个占位页仍可访问', async () => {
    const router = createTestRouter();

    expect(router.resolve('/workflows').name).toBe('workflows');
    expect(router.resolve('/toolbox').name).toBe('toolbox');

    await router.push('/workflows');
    expect(router.currentRoute.value.name).toBe('workflows');
    expect(router.currentRoute.value.meta.navKey).toBe('/workflows');

    await router.push('/toolbox');
    expect(router.currentRoute.value.name).toBe('toolbox');
    expect(router.currentRoute.value.meta.navKey).toBe('/toolbox');
  });

  it('四项完整能力页面已注册（books / models / runtime / 占位）', () => {
    const router = createTestRouter();
    expect(router.resolve('/books').name).toBe('books');
    expect(router.resolve('/models').name).toBe('models');
    expect(router.resolve('/runtime').name).toBe('runtime');
    expect(router.resolve('/workflows').name).toBe('workflows');
    expect(router.resolve('/toolbox').name).toBe('toolbox');
  });

  it('未知路径命中 404 回退路由而非白屏', async () => {
    const router = createTestRouter();
    await router.push('/not-exist/deep/path');

    expect(router.currentRoute.value.name).toBe('not-found');
    expect(router.currentRoute.value.meta.title).toBe('页面未找到');
  });
});
