#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const API_BASE = process.env.AIHOT_API_BASE ?? 'https://aihot.news/api/v1';
const DAILY_LIMIT = Math.max(1, Number(process.argv[process.argv.indexOf('--limit') + 1] ?? process.env.AIHOT_DAILY_LIMIT ?? 30) || 30);
const OUT = process.env.AIHOT_OUT
  ?? path.join(ROOT, 'output', `aihot-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);

function link(item) {
  return item.links?.story || item.links?.aihot || item.links?.original || '';
}

async function fetchJson(pathname, search = '') {
  const response = await fetch(`${API_BASE}${pathname}${search}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; stories-feed/1.0)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function hotItems(payload) {
  return (Array.isArray(payload.items) ? payload.items : []).flatMap((item) => {
    if (!item.id || !item.title) return [];
    return [{
      id: `hot:${item.id}`,
      type: 'hot',
      title: item.title,
      excerpt: `${item.sourceCount ?? 0} 个来源 · ${item.signalCount ?? 0} 条信号 · ${item.participantCount ?? 0} 个参与者`,
      author: { name: item.source?.name || 'AIHOT' },
      url: link(item),
      created_time: item.latestAt || undefined,
      source_count: item.sourceCount ?? 0,
      signal_count: item.signalCount ?? 0,
      participant_count: item.participantCount ?? 0,
    }];
  });
}

function dailyItems(payload) {
  return (Array.isArray(payload.items) ? payload.items : []).flatMap((item) => {
    if (!item.date || !item.leadTitle) return [];
    return [{
      id: `daily:${item.date}`,
      type: 'daily',
      title: item.leadTitle,
      excerpt: item.leadParagraph || '',
      author: { name: item.attribution?.name || 'AIHOT' },
      url: item.links?.aihot || '',
      created_time: item.generatedAt || undefined,
    }];
  });
}

const scrapedAt = new Date().toISOString();
const settled = await Promise.allSettled([
  fetchJson('/hot-topics'),
  fetchJson('/dailies', `?limit=${DAILY_LIMIT}`),
]);

const feeds = [];
const errors = [];
const transforms = [
  ['hot', hotItems],
  ['daily', dailyItems],
];
settled.forEach((result, index) => {
  const [name, transform] = transforms[index];
  if (result.status === 'rejected') {
    errors.push(`${name}: ${result.reason?.message ?? result.reason}`);
    return;
  }
  const items = transform(result.value);
  if (items.length > 0) {
    feeds.push({ source: name, method: 'api', count: items.length, items });
  }
});

if (feeds.length === 0) {
  throw new Error(`AIHOT API 没有可用数据（${errors.join('; ')}）`);
}

const result = { source: 'aihot', scraped_at: scrapedAt, feeds };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
const summary = feeds.map((feed) => `${feed.source}=${feed.count}`).join(', ');
console.log(`[aihot] ${API_BASE} -> ${OUT}（${summary}）`);
if (errors.length > 0) console.warn(`[aihot] 部分流失败: ${errors.join('; ')}`);
