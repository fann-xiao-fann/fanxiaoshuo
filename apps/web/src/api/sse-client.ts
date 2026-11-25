import { API_BASE_URL } from './config';
import { networkError, normalizeApiError } from './errors';

/**
 * 通用 `POST + SSE` 流式客户端。
 *
 * 浏览器原生 `EventSource` 只支持 GET，无法携带长上下文请求体，
 * 因此章内 AI 写作统一采用 `fetch` + `ReadableStream` + `AbortController`：
 * - 支持任意大小的 JSON 请求体（设定卡、正文、指令）；
 * - 支持一键中止（`controller.abort()`）；
 * - 非 2xx 响应可在建立流之前直接解析为标准 `ApiError`。
 *
 * 帧解析严格遵循 SSE 规范：兼容 `\r\n` / `\n`、任意分块粘包与拆包、
 * 多行 `data:` 拼接、`:` 注释心跳行，并在流结束时冲刷残留缓冲。
 */

/** 单条 SSE 事件回调：`eventName` 缺省为 `message`。 */
export interface SseStreamHandlers {
  onEvent: (eventName: string, dataText: string) => void;
}

export interface SseStreamOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** SSE 规范：未声明 `event:` 字段时事件名为 `message`。 */
export const SSE_DEFAULT_EVENT_NAME = 'message';

/** 判断异常是否为请求中止（浏览器 `AbortController` 与 polyfill 兼容）。 */
export function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

/** 构造标准的 AbortError，保持与 `fetch` 中止行为一致。 */
export function createAbortError(message = '请求已中止'): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException(message, 'AbortError');
  }
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

interface FrameState {
  eventName: string | null;
  dataLines: string[];
  hasData: boolean;
}

function createFrameState(): FrameState {
  return { eventName: null, dataLines: [], hasData: false };
}

function dispatchFrame(state: FrameState, handlers: SseStreamHandlers): void {
  const shouldDispatch = state.hasData || state.eventName !== null;
  if (shouldDispatch) {
    handlers.onEvent(state.eventName ?? SSE_DEFAULT_EVENT_NAME, state.dataLines.join('\n'));
  }
  state.eventName = null;
  state.dataLines = [];
  state.hasData = false;
}

/** 处理单行 SSE 字段（空行代表事件结束）。 */
function consumeLine(line: string, state: FrameState, handlers: SseStreamHandlers): void {
  if (line.length === 0) {
    dispatchFrame(state, handlers);
    return;
  }
  // 以 `:` 开头的是注释（服务端心跳），直接忽略。
  if (line.startsWith(':')) {
    return;
  }
  const colonIndex = line.indexOf(':');
  const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
  let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
  // 规范：字段值前允许且仅允许一个可选空格。
  if (value.startsWith(' ')) {
    value = value.slice(1);
  }
  switch (field) {
    case 'event':
      state.eventName = value.length > 0 ? value : null;
      break;
    case 'data':
      state.dataLines.push(value);
      state.hasData = true;
      break;
    // `id` / `retry` 与一次性对话无关，忽略即可。
    default:
      break;
  }
}

/**
 * 把缓冲文本按行切分并消费完整行，返回尚未完整的尾部。
 * - `flush = false`：保留末尾换行后的残行（可能还在下一秒到达）。
 * - `flush = true`：流已结束，全部行按完整行处理。
 *
 * 换行归一化要点：若缓冲以 `\r` 结尾，先摘下它，
 * 避免 `\r\n` 恰好被拆到两个 chunk 时被误判为两个换行。
 */
function drainBuffer(
  buffer: string,
  flush: boolean,
  state: FrameState,
  handlers: SseStreamHandlers,
): string {
  let text = buffer;
  let pendingCarriageReturn = '';
  if (!flush && text.endsWith('\r')) {
    pendingCarriageReturn = '\r';
    text = text.slice(0, -1);
  }
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const remainder = flush ? '' : (lines.pop() ?? '');
  for (const line of lines) {
    consumeLine(line, state, handlers);
  }
  return `${remainder}${pendingCarriageReturn}`;
}

/** 非 2xx 时读取错误响应体：优先 JSON，其次原始文本（供 `normalizeApiError` 兜底）。 */
async function readErrorPayload(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (text.trim().length === 0) {
    return undefined;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json') || text.trim().startsWith('{')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * 发起 `POST + SSE` 请求并逐帧回调，直到流结束。
 *
 * @throws `ApiClientError` 非 2xx（保留 `409 AGENT_ROLE_UNBOUND` / `400 AI_EMPTY_CONTEXT` 等原始错误码）
 * @throws `ApiClientError` `NETWORK_ERROR` 网络不可达
 * @throws `AbortError` 调用方通过 `options.signal` 主动中止（原样透传，便于识别）
 */
export async function streamSsePost(
  path: string,
  body: unknown,
  handlers: SseStreamHandlers,
  options: SseStreamOptions = {},
): Promise<void> {
  const url = `${API_BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: options.signal,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw networkError(error);
  }

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw normalizeApiError(response.status, payload);
  }

  const state = createFrameState();
  let buffer = '';

  if (response.body !== null && response.body !== undefined) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          if (options.signal?.aborted === true) {
            throw createAbortError();
          }
          throw networkError(error);
        }
        if (chunk.done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = drainBuffer(buffer, false, state, handlers);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* 已释放或流已终止：忽略 */
      }
    }
  } else {
    // 兜底：测试环境或代理可能不提供 body 流，退化为一次性文本解析。
    buffer += await response.text();
  }

  buffer = drainBuffer(buffer, true, state, handlers);
  // 服务端未以空行收尾时，最后一条事件仍需派发。
  dispatchFrame(state, handlers);
}
