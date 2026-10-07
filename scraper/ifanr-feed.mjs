#!/usr/bin/env node
/**
 * ifanr-feed.mjs — 抓取爱范儿官方 RSS 输出 JSON。
 *
 * 与 weibo/hn 同类：公开源、无需登录/签名/Playwright。输出结构与其它源同构
 * （{ scraped_at, feeds: [{ source, items }] }），便于 sync/tag/profile/rank 复用。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = import.meta.dirname;
const FEED_URL = process.env.IFANR_FEED_URL ?? 'https://www.ifanr.com/feed';
const LIMIT = Math.max(1, Number(process.argv[process.argv.indexOf('--limit') + 1] ?? process.env.IFANR_LIMIT ?? 30) || 30);
const OUT = process.env.IFANR_OUT
  ?? path.join(ROOT, 'output', `ifanr-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);

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

function rawId(link, guid) {
  const match = `${link} ${guid}`.match(/(?:\?p=|\/)(\d{3,})/);
  return match ? match[1] : (link || guid).replace(/[?#].*$/, '').replace(/\/$/, '').split('/').pop();
}

function parseRss(xml) {
  const channel = xml.match(/<channel[\s\S]*?>([\s\S]*)<\/channel>/i)?.[1] ?? '';
  return [...channel.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
    .map((match) => match[1])
    .map((item) => ({
      title: tagValue(item, 'title'),
      link: tagValue(item, 'link'),
      guid: tagValue(item, 'guid'),
      creator: tagValue(item, 'dc:creator'),
      pubDate: tagValue(item, 'pubDate'),
      image: tagValue(item, 'image'),
      description: tagValue(item, 'description'),
      categories: [...item.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
        .map((match) => stripHtml(match[1]))
        .filter(Boolean),
    }))
    .filter((item) => item.title && (item.link || item.guid));
}

async function fetchFeed() {
  const response = await fetch(FEED_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; stories-feed/1.0)',
      Accept: 'application/rss+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

const scrapedAt = new Date().toISOString();
const rawItems = parseRss(await fetchFeed()).slice(0, LIMIT);
if (rawItems.length === 0) throw new Error('RSS 中没有条目');

const seen = new Set();
const items = [];
for (const item of rawItems) {
  const id = rawId(item.link, item.guid);
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const createdAt = Date.parse(item.pubDate);
  const url = item.link.replace(/[?&](utm_[^=&]+)=[^&]*/g, '').replace(/\?$/, '');
  items.push({
    id,
    type: 'article',
    title: item.title,
    excerpt: stripHtml(item.description).slice(0, 500),
    author: { name: item.creator || '爱范儿' },
    url,
    cover: item.image.startsWith('https://') ? item.image : undefined,
    created_time: Number.isFinite(createdAt) ? new Date(createdAt).toISOString() : scrapedAt,
    categories: item.categories,
  });
}

const result = {
  source: 'ifanr',
  scraped_at: scrapedAt,
  feeds: [{ source: 'latest', method: 'rss', count: items.length, items }],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
console.log(`[ifanr] ${FEED_URL} -> ${OUT}（${items.length} 条）`);
