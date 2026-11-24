import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, buildQueryString } from '@/api/http';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildQueryString', () => {
  it('忽略空值并正确编码', () => {
    expect(
      buildQueryString({
        page: 2,
        pageSize: 20,
        status: undefined,
        role: null,
        scene: '',
        keyword: '两个 字',
      }),
    ).toBe('?page=2&pageSize=20&keyword=%E4%B8%A4%E4%B8%AA+%E5%AD%97');
  });

  it('无有效参数时返回空字符串', () => {
    expect(buildQueryString()).toBe('');
    expect(buildQueryString({ a: undefined, b: '' })).toBe('');
  });
});

describe('apiRequest', () => {
  it('解析成功响应并通过 Zod 校验', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [],
        total: 0,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { providerListResponseSchema } = await import('@fanxiaoshuo/shared');
    const result = await apiRequest('/providers', providerListResponseSchema, {
      query: { keyword: 'abc' },
    });

    expect(result).toEqual({ items: [], total: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/providers?keyword=abc');
    expect(init.method).toBe('GET');
  });

  it('非 2xx 响应转换为 ApiClientError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 'MODEL_NOT_FOUND', message: '模型不存在' }, 404),
      ),
    );

    const { modelDtoSchema } = await import('@fanxiaoshuo/shared');
    await expect(apiRequest('/models/missing', modelDtoSchema)).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'MODEL_NOT_FOUND',
      status: 404,
    });
  });

  it('响应不符合契约时抛出 INVALID_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: 'invalid' })));

    const { providerListResponseSchema } = await import('@fanxiaoshuo/shared');
    await expect(apiRequest('/providers', providerListResponseSchema)).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'INVALID_RESPONSE',
      status: 0,
    });
  });
});
