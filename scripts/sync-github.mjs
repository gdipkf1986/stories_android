#!/usr/bin/env node
/**
 * 把抓取输出目录里最新的 GitHub Trending 结果同步到前端静态目录 public/data/。
 *
 * 只看项目内 scraper/output/（Trending 抓取无需登录态）。
 * 也可用 GITHUB_OUTPUT_DIR 显式指定。
 *
 * 用法:
 *   npm run sync:github
 */
import { readdir, readFile, copyFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { applyTags, loadTagStore } from '../scraper/tag-store.mjs';
import { applySummaries, loadSummaryStore } from '../scraper/summary-store.mjs';

const FEED_RE = /^github-feed-.*\.json$/;
const SOURCE = 'github';
const localDir = path.resolve(import.meta.dirname, '../scraper/output');

async function hasFeeds(dir) {
  try {
    return (await readdir(dir)).some((f) => FEED_RE.test(f));
  } catch {
    return false;
  }
}

const outputDir = process.env.GITHUB_OUTPUT_DIR || localDir;
const target = path.resolve(import.meta.dirname, '../public/data/github-feed.json');

if (!(await hasFeeds(outputDir))) {
  console.error(`[sync:github] 在 ${outputDir} 下没有找到 github-feed-*.json`);
  process.exit(1);
}

const files = (await readdir(outputDir)).filter((f) => FEED_RE.test(f)).sort();
const latest = files[files.length - 1];
await mkdir(path.dirname(target), { recursive: true });
await copyFile(path.join(outputDir, latest), target);

const data = JSON.parse(await readFile(target, 'utf8'));
const count = data.feeds?.reduce((sum, f) => sum + (f.items?.length ?? 0), 0) ?? 0;

// 合并标签与摘要：两者都独立持久化（按条目 id 索引），重新抓取不会丢，
// 一次写盘合并注入（标签库 github-tags.json / 摘要库 github-summaries.json）
const store = await loadTagStore(SOURCE);
const summaries = await loadSummaryStore(SOURCE);
const hasTags = store.size > 0;
const hasSummaries = summaries.size > 0;
let taggedNote = '';
if (hasTags) taggedNote += `，已注入 AI 标签 ${applyTags(data, store)} 条`;
if (hasSummaries) taggedNote += `，已注入摘要 ${applySummaries(data, summaries)} 条`;
if (hasTags || hasSummaries) {
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
await chmod(target, 0o644); // NAS 权限保护层：防止 nginx 容器 403

console.log(
  `[sync:github] ${latest} -> public/data/github-feed.json（${count} 条，抓取于 ${data.scraped_at}${taggedNote}）`,
);
