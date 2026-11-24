#!/usr/bin/env node
/**
 * 跨平台本地环境初始化脚本：
 * 1. 若根目录不存在 `.env`，从 `.env.example` 复制一份；
 * 2. 若 `APP_ENCRYPTION_KEY` 仍为空，则用 node:crypto 生成 32 字节随机 hex 主密钥写入。
 * `.env` 已在 .gitignore 中忽略，永不入库。
 */
import { randomBytes } from 'node:crypto';
import { copyFile, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(rootDir, '.env.example');
const envPath = path.join(rootDir, '.env');

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  if (!(await exists(templatePath))) {
    throw new Error('未找到 .env.example，无法初始化本地环境变量文件。');
  }

  if (!(await exists(envPath))) {
    await copyFile(templatePath, envPath);
    console.log('[env:init] 已根据 .env.example 创建 .env');
  } else {
    console.log('[env:init] 检测到 .env 已存在，仅补全缺失的 APP_ENCRYPTION_KEY');
  }

  const content = await readFile(envPath, 'utf8');
  if (/^APP_ENCRYPTION_KEY=\S+/m.test(content)) {
    console.log('[env:init] APP_ENCRYPTION_KEY 已配置，保持不变。');
    return;
  }

  const key = randomBytes(32).toString('hex');
  const next = content.includes('APP_ENCRYPTION_KEY=')
    ? content.replace(/^APP_ENCRYPTION_KEY=.*$/m, `APP_ENCRYPTION_KEY=${key}`)
    : `${content.trimEnd()}\nAPP_ENCRYPTION_KEY=${key}\n`;

  await writeFile(envPath, next, 'utf8');
  console.log('[env:init] 已生成新的 APP_ENCRYPTION_KEY（32 字节 hex）。');
}

main().catch((error) => {
  console.error('[env:init] failed:', error);
  process.exitCode = 1;
});
