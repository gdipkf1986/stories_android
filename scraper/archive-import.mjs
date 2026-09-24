#!/usr/bin/env node
/**
 * 把 public/data 下五个源的最新快照导入 SQLite 档案层。
 *
 * 用法:
 *   npm run archive:sync
 *   node scraper/archive-import.mjs --source hn
 *   STORIES_DB_FILE=/tmp/test.db node scraper/archive-import.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { archiveStats, importTimelineFeed, openArchive } from './archive-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FEED_FILES = {
  zhihu: 'public/data/zhihu-feed.json',
  bilibili: 'public/data/bilibili-feed.json',
  github: 'public/data/github-feed.json',
  weibo: 'public/data/weibo-feed.json',
  hn: 'public/data/hn-feed.json',
};

const onlySource = process.argv[process.argv.indexOf('--source') + 1];
const sources = onlySource && FEED_FILES[onlySource]
  ? [onlySource]
  : Object.keys(FEED_FILES);

const db = openArchive();
for (const source of sources) {
  const file = path.resolve(ROOT, FEED_FILES[source]);
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const capturedAt = Date.parse(raw.scraped_at) || Date.now();
    const result = importTimelineFeed(db, { source, raw, capturedAt });
    console.log(`[archive] ${source}: ${result.itemCount} items`);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.warn(`[archive] ${source}: ${FEED_FILES[source]} 不存在，跳过`);
      continue;
    }
    console.error(`[archive] ${source}: 导入失败：${error.message}`);
    process.exitCode = 1;
  }
}

const stats = archiveStats(db);
console.log(
  `[archive] items=${stats.items} contents=${stats.contents} ` +
    `tags=${stats.tags} summaries=${stats.summaries}`,
);
db.close();
