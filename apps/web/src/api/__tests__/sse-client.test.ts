import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAbortError, streamSsePost } from '@/api/sse-client';

const encoder = new TextEncoder();

function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function collect(): {
  events: Array<{ event: string; data: string }>;
  handlers: { onEvent: (event: string, data: string) => void };
} {
  const events: Array<{ event: string; data: string }> = [];
  return {
    events,
    handlers: {
      onEvent(event, data) {
        events.push({ event, data });
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamSsePost', () => {
  it('正确解析分块粘包 / 拆包、CRLF 与多行 data', async () => {
    const { events, handlers } = collect();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          // 注释心跳行（含 CRLF）应被忽略
          ': keep-alive\r\n\r\n',
          // 事件名与 data 被拆到两个 chunk，且换行跨越 chunk 边界
          'event: delta\r\ndata: {"text":"你',
          '好"}\r',
          '\n\r\n',
          // 多行 data 按规范以 \n 拼接
          'event: done\ndata: line-1\ndata: line-2\n\n',
        ]),
      ),
    );

    await streamSsePost('/chapters/x/ai/stream', { action: 'continue' }, handlers);

    expect(events).toEqual([
      { event: 'delta', data: '{"text":"你好"}' },
      { event: 'done', data: 'line-1\nline-2' },
    ]);
  });

  it('在 UTF-8 多字节字符中途分块时仍能正确解码', async () => {
    const { events, handlers } = collect();
    const full = 'event: delta\r\ndata: {"text":"雨夜追凶"}\r\n\r\n';
    const bytes = encoder.encode(full);
    // 在「雨」的第二个字节处切开，模拟网络分片
    const cut = full.indexOf('雨') + 1;
    const first = bytes.slice(0, cut);
    const second = bytes.slice(cut);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        ),
    );

    await streamSsePost('/chapters/x/ai/stream', {}, handlers);

    expect(events).toEqual([{ event: 'delta', data: '{"text":"雨夜追凶"}' }]);
  });

  it('未以空行收尾时仍派发最后一条事件', async () => {
    const { events, handlers } = collect();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse(['event: error\ndata: {"code":"AI_EMPTY_CONTEXT","message":"空正文"}']),
        ),
    );

    await streamSsePost('/chapters/x/ai/stream', {}, handlers);

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('error');
  });

  it('响应无 body 流时退化为整段文本解析', async () => {
    const { events, handlers } = collect();
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: null,
      text: async () => 'event: start\ndata: {"runId":"r"}\n\n',
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse));

    await streamSsePost('/chapters/x/ai/stream', {}, handlers);

    expect(events).toEqual([{ event: 'start', data: '{"runId":"r"}' }]);
  });

  it('非 2xx 的 JSON 错误体转换为 ApiClientError（保留业务错误码）', async () => {
    const { handlers } = collect();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 'AGENT_ROLE_UNBOUND', message: '执笔写手未绑定模型' }, 409),
      ),
    );

    await expect(streamSsePost('/chapters/x/ai/stream', {}, handlers)).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'AGENT_ROLE_UNBOUND',
      status: 409,
      message: '执笔写手未绑定模型',
    });
  });

  it('400 空上下文错误同样保留原始错误码', async () => {
    const { handlers } = collect();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ code: 'AI_EMPTY_CONTEXT', message: '当前没有可写内容' }, 400),
      ),
    );

    await expect(streamSsePost('/chapters/x/ai/stream', {}, handlers)).rejects.toMatchObject({
      code: 'AI_EMPTY_CONTEXT',
      status: 400,
    });
  });

  it('网络失败转换为 NETWORK_ERROR', async () => {
    const { handlers } = collect();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(streamSsePost('/chapters/x/ai/stream', {}, handlers)).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });

  it('AbortSignal 中止时原样透传 AbortError', async () => {
    const controller = new AbortController();
    const { handlers } = collect();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = streamSsePost('/chapters/x/ai/stream', {}, handlers, {
      signal: controller.signal,
    });
    controller.abort();

    const error: unknown = await pending.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(isAbortError(error)).toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe('{}');
  });
});
