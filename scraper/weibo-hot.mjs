#!/usr/bin/env node
/**
 * weibo-hot.mjs — 抓取微博热搜榜输出 JSON
 * 用法: node weibo-hot.mjs [--out <path>]
 *
 * 与 github-trending.mjs 同类：公开 JSON 接口（weibo.com 首页侧边栏的
 * /ajax/side/hotSearch），无需登录也不用起 Playwright，直接拉 JSON 解析。
 * 输出结构与 zhihu/bilibili/github 同构（{ scraped_at, feeds: [{ source, items }] }），
 * 后续 sync → tagger → ranker 全链路零改动复用。
 *
 * 接口要点（2026-09 实测）：
 *  - 必须带浏览器 UA + Referer: https://weibo.com/ + Accept，缺了返回 {"error":"Forbidden"}
 *  - data.realtime[] 每项: word（热搜词）/ num（热度值）/
 *    label_name（热/新/沸/爆…）/ note（导语，常与 word 相同）/ realpos / is_ad
 *  - is_ad / topic_ad 为真的条目是广告位，丢弃
 *  - 热搜没有发布时间字段，前端与排序端都回落 scraped_at（同 GitHub Trending 口径）
 *
 * 代理: 微博是国内站点默认直连（直连即可通）；直连失败回落 clash 隧道
 * （同 github-http.mjs 的 CONNECT 方案，Node fetch 不认代理环境变量）。
 *   WEIBO_PROXY=http://127.0.0.1:7890   显式指定代理
 *   WEIBO_PROXY=direct                  强制直连（不回落）
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import process from 'node:process';

const ROOT = import.meta.dirname;
const args = process.argv.slice(2);
function argOf(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const OUT =
  argOf('--out', '') ||
  path.join(ROOT, 'output', `weibo-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);

const API_URL = 'https://weibo.com/ajax/side/hotSearch';
const TIMEOUT_MS = 20_000;
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://weibo.com/',
};
const CLASH_PROXY = 'http://127.0.0.1:7890';
const PROXY = (() => {
  const explicit = process.env.WEIBO_PROXY;
  if (explicit !== undefined) {
    return /^(direct|off|none|)$/.test(explicit.trim()) ? null : explicit.trim();
  }
  return null; // 缺省直连，失败才临时回落 clash
})();

/** 通过 HTTP 代理 CONNECT 隧道发 HTTPS GET（同 github-http.mjs 的方案） */
function requestViaProxy(targetUrl, headers) {
  const u = new URL(targetUrl);
  const p = new URL(PROXY);
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${u.hostname}:443`,
      headers: { Host: `${u.hostname}:443` },
    });
    connect.setTimeout(TIMEOUT_MS, () => connect.destroy(new Error('代理 CONNECT 超时')));
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
        return;
      }
      const req = https.request(
        targetUrl,
        {
          method: 'GET',
          headers,
          agent: false,
          createConnection: () => tls.connect({ socket, servername: u.hostname }),
        },
        resolve,
      );
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      req.end();
    });
    connect.on('error', reject);
    connect.end();
  });
}

async function readBody(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** 直连优先（国内站），失败回落 clash 隧道；WEIBO_PROXY=direct 强制直连不回落 */
async function fetchHotSearch() {
  const attempts = PROXY === null && process.env.WEIBO_PROXY === undefined ? ['direct', CLASH_PROXY] : [PROXY ?? 'direct'];
  let lastErr;
  for (const via of attempts) {
    try {
      let status, body;
      if (via === 'direct') {
        const res = await fetch(API_URL, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
        status = res.status;
        body = await res.text();
      } else {
        const res = await requestViaProxy(API_URL, HEADERS);
        status = res.statusCode;
        body = await readBody(res);
      }
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const data = JSON.parse(body);
      if (data?.ok !== 1 || !Array.isArray(data?.data?.realtime)) {
        throw new Error(`响应异常: ${body.slice(0, 120)}`);
      }
      return data.data.realtime;
    } catch (e) {
      lastErr = e;
      if (via !== attempts[attempts.length - 1]) {
        console.log(`[WARN] 直连失败（${e.message}），回落 clash 隧道重试`);
      }
    }
  }
  throw lastErr;
}

/** 热搜词 → 微博移动端搜索页链接（浏览器免登录可用；s.weibo.com 会跳登录不采用） */
function searchUrl(word) {
  // containerid 值形如 100103type=1&q=词，整个作为 containerid 参数值编码
  return `https://m.weibo.cn/search?containerid=${encodeURIComponent(`100103type=1&q=${word}`)}`;
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  console.log(`[INFO] 抓取微博热搜 ${API_URL}`);
  const realtime = await fetchHotSearch();

  const items = [];
  for (const it of realtime) {
    const word = String(it.word ?? '').trim();
    if (!word) continue;
    if (it.is_ad || it.topic_ad) continue; // 广告位不是真实热搜
    const note = String(it.note ?? '').trim();
    items.push({
      id: word, // 热搜词即天然主键（同词复榜时打标/去重都按它对齐）
      type: 'hot',
      rank: Number.isFinite(it.realpos) ? it.realpos : items.length + 1,
      title: word,
      excerpt: note && note !== word ? note.slice(0, 300) : '',
      label: String(it.label_name ?? '').trim() || null, // 热/新/沸/爆…
      heat: Number.isFinite(it.num) ? it.num : null,
      author: { name: '微博热搜' },
      url: searchUrl(word),
      created_time: null, // 热搜无时间字段，前端归一化时回落到 scraped_at
      updated_time: null,
    });
  }

  if (items.length === 0) {
    console.error('[FAIL] 没有解析到任何热搜条目，不写出产物（保留上一次同步的数据）');
    process.exit(1);
  }

  const result = {
    scraped_at: new Date().toISOString(),
    feeds: [{ source: 'hot', method: 'json-api', count: items.length, items }],
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[DONE] 输出: ${OUT}`);
  console.log(`  - hot: ${items.length} 条（榜首: ${items[0]?.title}）`);
})();
