#!/usr/bin/env node
/**
 * 把最新的 InfoQ RSS 抓取产物同步到 public/data/infoq-feed.json。
 *
 * 用法:
 *   npm run sync:infoq
 */
import { readdir, readFile, copyFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { applyTags, loadTagStore } from '../scraper/tag-store.mjs';

const FEED_RE = /^infoq-feed-.*\.json$/;
const SOURCE = 'infoq';
const outputDir = process.env.INFOQ_OUTPUT_DIR || path.resolve(import.meta.dirname, '../scraper/output');
const target = path.resolve(import.meta.dirname, '../public/data/infoq-feed.json');

const files = (await readdir(outputDir).catch(() => [])).filter((name) => FEED_RE.test(name)).sort();
if (files.length === 0) {
  console.error(`[sync:infoq] 在 ${outputDir} 下没有找到 infoq-feed-*.json`);
  process.exit(1);
}

const latest = files[files.length - 1];
await mkdir(path.dirname(target), { recursive: true });
await copyFile(path.join(outputDir, latest), target);

const data = JSON.parse(await readFile(target, 'utf8'));
const count = data.feeds?.reduce((sum, feed) => sum + (feed.items?.length ?? 0), 0) ?? 0;
const store = await loadTagStore(SOURCE);
let taggedNote = '';
if (store.size > 0) {
  taggedNote = `，已注入 AI 标签 ${applyTags(data, store)} 条`;
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
await chmod(target, 0o644);

console.log(
  `[sync:infoq] ${latest} -> public/data/infoq-feed.json（${count} 条，抓取于 ${data.scraped_at}${taggedNote}）`,
);
