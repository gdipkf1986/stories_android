#!/usr/bin/env node
/**
 * github-trending.mjs — 抓取 GitHub Trending 榜单输出 JSON
 * 用法: node github-trending.mjs [--tabs daily,weekly,monthly] [--out <path>]
 *
 * 与 zhihu/bilibili 抓取器不同：Trending 是服务端渲染的公开页面，无需登录
 * 也不用起 Playwright，直接拉 HTML 按 <article class="Box-row"> 锚点解析。
 * 输出结构与 zhihu/bilibili 同构（{ scraped_at, feeds: [{ source, items }] }），
 * 后续 sync → tagger → ranker 全链路零改动复用。
 *
 * 代理: github.com 在部署机上通常直连不通，默认走 clash（http://127.0.0.1:7890）：
 *   GITHUB_PROXY=http://127.0.0.1:7890   显式指定代理（缺省即此值）
 *   GITHUB_PROXY=direct                   强制直连
 *   未设 GITHUB_PROXY 时读标准环境变量 https_proxy，再缺省 clash。
 *   代理连接失败会自动回落直连再试一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROXY, fetchText } from './github-http.mjs';

const ROOT = import.meta.dirname;
const args = process.argv.slice(2);
function argOf(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const TABS = argOf('--tabs', 'daily').split(',');
const OUT =
  argOf('--out', '') ||
  path.join(ROOT, 'output', `github-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);

/** since 参数 → 条目上的增量星标文案（前端 metrics 标签用） */
const TAB_DEFS = {
  daily: { url: 'https://github.com/trending?since=daily', period: 'today' },
  weekly: { url: 'https://github.com/trending?since=weekly', period: 'this week' },
  monthly: { url: 'https://github.com/trending?since=monthly', period: 'this month' },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numFrom = (s) => {
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
/** 最小 HTML 实体还原（描述文本里常见 &amp; &#39; 等） */
function decodeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** 解析 Trending 页 HTML → 与知乎/B站条目同构的轻量结构 */
function parseTrending(html, period) {
  const items = [];
  const articles = [...html.matchAll(/<article class="Box-row">([\s\S]*?)<\/article>/g)];
  for (const [, body] of articles) {
    const href = ((body.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/) || [])[1] || '').trim();
    if (!/^\/[^/]+\/[^/]+$/.test(href)) continue; // 只要 /owner/name 形态
    const [, owner, name] = href.replace(/\.git$/, '').split('/'); // 前导 "/" 产出空首段，跳过
    if (!owner || !name) continue;
    const re = escapeRe(`/${owner}/${name}`);
    const desc = decodeHtml(((body.match(/<p class="col-9[^"]*">\s*([\s\S]*?)<\/p>/) || [])[1] || ''))
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const language = ((body.match(/itemprop="programmingLanguage">([^<]*)</) || [])[1] || '').trim();
    const stars = numFrom((body.match(new RegExp(`<a href="${re}/stargazers"[\\s\\S]*?</svg>\\s*([\\d,]+)\\s*</a>`)) || [])[1]);
    const forks = numFrom((body.match(new RegExp(`<a href="${re}/forks"[\\s\\S]*?</svg>\\s*([\\d,]+)\\s*</a>`)) || [])[1]);
    const starsPeriod = numFrom((body.match(/([\d,]+)\s*stars?\s*(?:today|this week|this month)/i) || [])[1]);
    items.push({
      id: `${owner}/${name}`,
      type: 'trending',
      rank: items.length + 1,
      title: `${owner}/${name}`,
      excerpt: desc.slice(0, 300),
      author: { name: owner, url: `https://github.com/${owner}` },
      url: `https://github.com/${owner}/${name}`,
      language: language || null,
      stars,
      forks,
      stars_period: starsPeriod,
      period,
      created_time: null, // Trending 页没有时间字段，前端归一化时回落到 scraped_at
      updated_time: null,
    });
  }
  return items;
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const result = { scraped_at: new Date().toISOString(), feeds: [] };

  for (const tab of TABS) {
    const def = TAB_DEFS[tab.trim()];
    if (!def) {
      console.log(`[SKIP] 未知 tab: ${tab}（可选: ${Object.keys(TAB_DEFS).join('/')}）`);
      continue;
    }
    console.log(`[INFO] 抓取 GitHub Trending ${tab} → ${def.url}${PROXY ? `（经 ${PROXY}）` : '（直连）'}`);
    try {
      const items = parseTrending(await fetchText(def.url), def.period);
      result.feeds.push({ source: tab.trim(), method: 'html-parse', count: items.length, items });
      console.log(`[OK] ${tab}: ${items.length} 条`);
    } catch (e) {
      console.error(`[FAIL] ${tab}: ${e.message}`);
      result.feeds.push({ source: tab.trim(), error: e.message, count: 0, items: [] });
    }
  }

  const total = result.feeds.reduce((sum, f) => sum + f.count, 0);
  if (total === 0) {
    console.error('[FAIL] 所有 tab 都没抓到条目，不写出产物（保留上一次同步的数据）');
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[DONE] 输出: ${OUT}`);
  result.feeds.forEach((f) =>
    console.log(`  - ${f.source}: ${f.count} 条${f.error ? ` (error: ${f.error})` : ''}`),
  );
})();
