#!/usr/bin/env node
/**
 * 把抓取输出目录里最新的结果同步到前端静态目录 public/data/。
 *
 * 优先用项目内 scraper/output/；为空时回退到旧目录 ~/zhihu-scraper/output/。
 * 也可用 ZHIHU_OUTPUT_DIR 显式指定。
 *
 * 用法:
 *   npm run sync:zhihu
 */
import { readdir, readFile, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { applyTags, loadTagStore } from '../scraper/tag-store.mjs';
import { recordSourceLoginCheck } from '../scraper/source-login-store.mjs';

const FEED_RE = /^zhihu-feed-.*\.json$/;
const localDir = path.resolve(import.meta.dirname, '../scraper/output');
const legacyDir = path.join(homedir(), 'zhihu-scraper', 'output');

async function hasFeeds(dir) {
  try {
    return (await readdir(dir)).some((f) => FEED_RE.test(f));
  } catch {
    return false;
  }
}

let outputDir = process.env.ZHIHU_OUTPUT_DIR;
if (!outputDir) {
  outputDir = (await hasFeeds(localDir)) ? localDir : legacyDir;
}
const target = path.resolve(import.meta.dirname, '../public/data/zhihu-feed.json');
const statusFile = path.resolve(import.meta.dirname, '../scraper/storage/source-status.json');

const files = (await readdir(outputDir)).filter((f) => FEED_RE.test(f)).sort();
if (files.length === 0) {
  console.error(`[sync:zhihu] 在 ${outputDir} 下没有找到 zhihu-feed-*.json`);
  process.exit(1);
}

const latest = files[files.length - 1];
await mkdir(path.dirname(target), { recursive: true });
await copyFile(path.join(outputDir, latest), target);

const data = JSON.parse(await readFile(target, 'utf8'));
const count = data.feeds?.reduce((sum, f) => sum + (f.items?.length ?? 0), 0) ?? 0;
if ('login_required' in data) {
  recordSourceLoginCheck('zhihu', {
    required: data.login_required === true,
    reason: data.login_reason ?? '',
    checkedAt: data.scraped_at,
  }, statusFile);
}

// 合并 AI 标签：标签库独立持久化（按条目 id 索引），重新抓取不会丢标签
const store = await loadTagStore();
let taggedNote = '';
if (store.size > 0) {
  const tagged = applyTags(data, store);
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  taggedNote = `，已注入 AI 标签 ${tagged} 条`;
}

console.log(
  `[sync:zhihu] ${latest} -> public/data/zhihu-feed.json（${count} 条，抓取于 ${data.scraped_at}${taggedNote}）`,
);
