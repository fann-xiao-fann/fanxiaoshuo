/**
 * @fanxiaoshuo/shared — 梵小说共享契约包（唯一真相来源）。
 *
 * 目录所有权：Contract Owner（先行锁定）。任何跨包数据结构变更必须先改本包并冻结契约，
 * 服务端 / Worker / 前端禁止各自定义重复类型。
 */
export * from './constants/agent-roles.js';
export * from './constants/books.js';
export * from './constants/book-bible.js';
export * from './constants/provider-protocols.js';
export * from './constants/runtime.js';

export * from './errors.js';

export * from './utils/word-count.js';

export * from './schemas/primitives.js';
export * from './schemas/provider.js';
export * from './schemas/model.js';
export * from './schemas/agent-role-binding.js';
export * from './schemas/usage-log.js';
export * from './schemas/health.js';
export * from './schemas/runtime-job.js';
export * from './schemas/book.js';
export * from './schemas/volume.js';
export * from './schemas/chapter.js';
export * from './schemas/chapter-revision.js';
export * from './schemas/book-bible.js';
export * from './schemas/ai-writer.js';
