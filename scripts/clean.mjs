#!/usr/bin/env node
/**
 * 跨平台清理脚本（替代 POSIX 独占的 `rm -rf`）。
 * 删除根目录以及各 workspace（apps/*、packages/*）下的构建产物目录。
 */
import { readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRS = ['dist', 'build', '.vite', 'coverage', 'node_modules/.vite'];
const WORKSPACE_ROOTS = ['apps', 'packages'];

/** @param {string} dir */
async function removeArtifacts(dir) {
  let removed = 0;
  for (const target of TARGET_DIRS) {
    const absolute = path.join(dir, target);
    if (existsSync(absolute)) {
      await rm(absolute, { recursive: true, force: true });
      removed += 1;
      console.log(`[clean] removed ${path.relative(rootDir, absolute) || '.'}`);
    }
  }
  return removed;
}

async function main() {
  let total = await removeArtifacts(rootDir);

  for (const group of WORKSPACE_ROOTS) {
    const groupDir = path.join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    const entries = await readdir(groupDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      total += await removeArtifacts(path.join(groupDir, entry.name));
    }
  }

  console.log(`[clean] done, ${total} artifact director${total === 1 ? 'y' : 'ies'} removed.`);
}

main().catch((error) => {
  console.error('[clean] failed:', error);
  process.exitCode = 1;
});
