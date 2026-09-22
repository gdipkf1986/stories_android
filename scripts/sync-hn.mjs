#!/usr/bin/env node
/**
 * 把抓取输出目录里最新的 Hacker News 榜单结果同步到前端静态目录 public/data/。
 *
 * 只看项目内 scraper/output/（HN 抓取无需登录态）。
 * 也可用 HN_OUTPUT_DIR 显式指定。
 *
 * 用法:
 *   npm run sync:hn
 */
import { readdir, readFile, copyFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { applyTags, loadTagStore } from '../scraper/tag-store.mjs';

const FEED_RE = /^hn-feed-.*\.json$/;
const SOURCE = 'hn';
const localDir = path.resolve(import.meta.dirname, '../scraper/output');

async function hasFeeds(dir) {
  try {
    return (await readdir(dir)).some((f) => FEED_RE.test(f));
  } catch {
    return false;
  }
}

const outputDir = process.env.HN_OUTPUT_DIR || localDir;
const target = path.resolve(import.meta.dirname, '../public/data/hn-feed.json');

if (!(await hasFeeds(outputDir))) {
  console.error(`[sync:hn] 在 ${outputDir} 下没有找到 hn-feed-*.json`);
  process.exit(1);
}

const files = (await readdir(outputDir)).filter((f) => FEED_RE.test(f)).sort();
const latest = files[files.length - 1];
await mkdir(path.dirname(target), { recursive: true });
await copyFile(path.join(outputDir, latest), target);

const data = JSON.parse(await readFile(target, 'utf8'));
const count = data.feeds?.reduce((sum, f) => sum + (f.items?.length ?? 0), 0) ?? 0;

// 合并 AI 标签：标签独立持久化（按条目 id 索引），重新抓取不会丢（库 hn-tags.json）
const store = await loadTagStore(SOURCE);
let taggedNote = '';
if (store.size > 0) {
  taggedNote = `，已注入 AI 标签 ${applyTags(data, store)} 条`;
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
await chmod(target, 0o644); // NAS 权限保护层：防止 nginx 容器 403

console.log(
  `[sync:hn] ${latest} -> public/data/hn-feed.json（${count} 条，抓取于 ${data.scraped_at}${taggedNote}）`,
);
