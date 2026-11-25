import type {
  BookDto,
  BookTreeResponse,
  ChapterDetailDto,
  ChapterSaveResponse,
  ChapterTreeItem,
  VolumeDto,
} from '@fanxiaoshuo/shared';
import type { FastifyInstance } from 'fastify';

/** 书库集成测试共用的请求封装（`fastify.inject()`，无需真实数据库）。 */

/** 可控时钟：`createTestServer({ clock })` 同时注入服务端与内存仓储。 */
export interface ManualClock {
  (): Date;
  /** 前进指定毫秒（模拟编辑间隔 / 自动快照节流窗口） */
  advance(ms: number): void;
  /** 当前时间副本 */
  now(): Date;
}

export function createManualClock(startIso = '2025-01-01T00:00:00.000Z'): ManualClock {
  let current = new Date(startIso).getTime();
  const clock = (() => new Date(current)) as ManualClock;
  clock.advance = (ms: number) => {
    current += ms;
  };
  clock.now = () => new Date(current);
  return clock;
}

export async function createBook(
  app: FastifyInstance,
  payload: Record<string, unknown> = {},
): Promise<BookDto> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/books',
    payload: { title: '剑起长安', ...payload },
  });
  if (response.statusCode !== 201) {
    throw new Error(`创建书籍失败：${response.statusCode} ${response.body}`);
  }
  return response.json<BookDto>();
}

export async function createVolume(
  app: FastifyInstance,
  bookId: string,
  payload: Record<string, unknown> = {},
): Promise<VolumeDto> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/books/${bookId}/volumes`,
    payload: { title: '第一卷', ...payload },
  });
  if (response.statusCode !== 201) {
    throw new Error(`创建分卷失败：${response.statusCode} ${response.body}`);
  }
  return response.json<VolumeDto>();
}

export async function createChapter(
  app: FastifyInstance,
  bookId: string,
  payload: Record<string, unknown> = {},
): Promise<ChapterTreeItem> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/books/${bookId}/chapters`,
    payload: { title: '第一章', ...payload },
  });
  if (response.statusCode !== 201) {
    throw new Error(`创建章节失败：${response.statusCode} ${response.body}`);
  }
  return response.json<ChapterTreeItem>();
}

export async function getChapter(
  app: FastifyInstance,
  chapterId: string,
): Promise<ChapterDetailDto> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/chapters/${chapterId}`,
  });
  if (response.statusCode !== 200) {
    throw new Error(`读取章节失败：${response.statusCode} ${response.body}`);
  }
  return response.json<ChapterDetailDto>();
}

export async function saveChapterContent(
  app: FastifyInstance,
  chapterId: string,
  payload: Record<string, unknown>,
): Promise<ChapterSaveResponse> {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/v1/chapters/${chapterId}/content`,
    payload,
  });
  if (response.statusCode !== 200) {
    throw new Error(`保存正文失败：${response.statusCode} ${response.body}`);
  }
  return response.json<ChapterSaveResponse>();
}

export async function getTree(app: FastifyInstance, bookId: string): Promise<BookTreeResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/books/${bookId}/tree`,
  });
  if (response.statusCode !== 200) {
    throw new Error(`读取目录树失败：${response.statusCode} ${response.body}`);
  }
  return response.json<BookTreeResponse>();
}
