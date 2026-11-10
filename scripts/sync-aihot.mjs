#!/usr/bin/env node
import { readdir, readFile, copyFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { applyTags, loadTagStore } from '../scraper/tag-store.mjs';

const FEED_RE = /^aihot-feed-.*\.json$/;
const SOURCE = 'aihot';
const outputDir = process.env.AIHOT_OUTPUT_DIR || path.resolve(import.meta.dirname, '../scraper/output');
const target = path.resolve(import.meta.dirname, '../public/data/aihot-feed.json');

const files = (await readdir(outputDir).catch(() => [])).filter((name) => FEED_RE.test(name)).sort();
if (files.length === 0) {
  console.error(`[sync:aihot] 在 ${outputDir} 下没有找到 aihot-feed-*.json`);
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
  `[sync:aihot] ${latest} -> public/data/aihot-feed.json（${count} 条，抓取于 ${data.scraped_at}${taggedNote}）`,
);
