#!/usr/bin/env node
/**
 * ruanyifeng-feed.mjs — 抓取阮一峰的网络日志 Atom 输出 JSON。
 *
 * 公开源、无需登录/签名/Playwright。输出结构与其它源同构
 * （{ scraped_at, feeds: [{ source, items }] }），便于 sync/tag/profile/rank 复用。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = import.meta.dirname;
const FEED_URL = process.env.RUANYIFENG_FEED_URL ?? 'https://www.ruanyifeng.com/blog/atom.xml';
const LIMIT = Math.max(1, Number(process.argv[process.argv.indexOf('--limit') + 1] ?? process.env.RUANYIFENG_LIMIT ?? 30) || 30);
const OUT = process.env.RUANYIFENG_OUT
  ?? path.join(ROOT, 'output', `ruanyifeng-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(value = '') {
  return decodeXml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(item, name) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function alternateLink(item) {
  const match = item.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i)
    ?? item.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return match ? decodeXml(match[1]).trim() : '';
}

function rawId(link, id) {
  const slug = link.match(/\/blog\/\d{4}\/\d{2}\/([^/?#]+?)(?:\.html)?\/?$/);
  if (slug) return slug[1];
  const numeric = id.match(/\.(\d+)$/);
  return numeric ? numeric[1] : id.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function parseAtom(xml) {
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)]
    .map((match) => match[1])
    .map((item) => {
      const content = tagValue(item, 'content');
      return {
        title: tagValue(item, 'title'),
        link: alternateLink(item),
        id: tagValue(item, 'id'),
        author: item.match(/<author\b[^>]*>\s*<name(?:\s[^>]*)?>([\s\S]*?)<\/name>/i)?.[1]?.trim() ?? '',
        published: tagValue(item, 'published') || tagValue(item, 'updated'),
        summary: tagValue(item, 'summary'),
        content,
        cover: content.match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] ?? '',
        categories: [...item.matchAll(/<category\b[^>]*term=["']([^"']+)["'][^>]*>/gi)]
          .map((match) => decodeXml(match[1]).trim())
          .filter(Boolean),
      };
    })
    .filter((item) => item.title && (item.link || item.id));
}

async function fetchFeed() {
  const response = await fetch(FEED_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; stories-feed/1.0)',
      Accept: 'application/atom+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

const scrapedAt = new Date().toISOString();
const rawItems = parseAtom(await fetchFeed()).slice(0, LIMIT);
if (rawItems.length === 0) throw new Error('Atom 中没有条目');

const seen = new Set();
const items = [];
for (const item of rawItems) {
  const id = rawId(item.link, item.id);
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const createdAt = Date.parse(item.published);
  const url = (item.link || '').replace(/^http:\/\//i, 'https://');
  items.push({
    id,
    type: 'article',
    title: item.title,
    excerpt: (stripHtml(item.summary) || stripHtml(item.content)).slice(0, 500),
    author: { name: item.author || '阮一峰' },
    url,
    cover: item.cover.replace(/^http:\/\//i, 'https://') || undefined,
    created_time: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : scrapedAt,
    categories: item.categories,
  });
}

const result = {
  source: 'ruanyifeng',
  scraped_at: scrapedAt,
  feeds: [{ source: 'latest', method: 'atom', count: items.length, items }],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`[ruanyifeng] ${FEED_URL} -> ${OUT}（${items.length} 条）`);
