#!/usr/bin/env node
/**
 * hn-hot.mjs — 抓取 Hacker News 榜单输出 JSON
 * 用法: node hn-hot.mjs [--limit 30] [--out <path>]
 *
 * 与 weibo-hot.mjs 同类：官方公开 Firebase API，无需登录/签名/Playwright，
 * 是所有源里抓取成本最低的一路。输出结构与 zhihu/bilibili/github/weibo
 * 同构（{ scraped_at, feeds: [{ source, items }] }），全链路零改动复用。
 *
 * 接口要点（2026-09 实测）：
 *  - v0/topstories.json（front page）/ v0/beststories.json → 条目 id 列表（各 500 条）
 *  - v0/item/{id}.json → { id, type:"story", title, score, by, time(Unix 秒),
 *    url?(外链故事), text?(Ask HN 类自述，HTML), descendants?(评论数) }
 *  - 无外链的条目（Ask HN 等）url 落讨论页 hn_url
 *
 * 网络（2026-09 实测踩坑，别"优化"回去）：
 *  - hacker-news.firebaseio.com 在部署机上 DNS 轮询出多个 Google LB IP，其中
 *    部分是黑洞（TCP 可达性看脸）；node fetch(undici) 的 connect 失败会长时间
 *    悬挂且 AbortSignal 之前的等待不可控，同刻 curl/https.get 都秒通。
 *  - 所以直连腿用**核心 https.get + 硬超时**（超时一定触发），失败立刻重试——
 *    每次尝试都是新一次 DNS 掷骰，换到好 IP 即成功。
 *  - clash 隧道只作最后兜底（自身也有 ~1/6 假死率），同样外挂硬超时，
 *    到点连 CONNECT 控制连接一起强杀。
 *  - 进程级看门狗兜底：调度器 spawnSync 无超时，本脚本挂住 = 整条抓取管线冻结。
 *
 *   HN_PROXY=direct   不走 clash 兜底（纯直连重试）
 *   HN_PROXY=<url>    显式指定兜底代理（缺省 clash 127.0.0.1:7890）
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
const LIMIT = Math.max(1, Number(argOf('--limit', '30')) || 30);
const OUT =
  argOf('--out', '') ||
  path.join(ROOT, 'output', `hn-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);

const API = 'https://hacker-news.firebaseio.com/v0';
// feeds[].source 的取值，前端子板块注册表（mobile/src/api/sources.ts）与之对应
const FEEDS = {
  top: `${API}/topstories.json`, // front page 热榜
  best: `${API}/beststories.json`, // best 综合最佳
};
const CONCURRENCY = 8; // 条目详情并发数（Firebase API 限流宽松，8 并发亚秒完成）
const DIRECT_MS = 6_000; // 单次直连硬超时（成功连接实测 ~1-2s）
const TUNNEL_MS = 12_000; // 单次 clash 隧道硬超时
const WATCHDOG_MS = 300_000; // 整个进程的存续上限（防 spawnSync 悬死）
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/json',
};
const CLASH_PROXY = 'http://127.0.0.1:7890';
const PROXY = (() => {
  const explicit = process.env.HN_PROXY;
  if (explicit !== undefined) {
    return /^(direct|off|none|)$/.test(explicit.trim()) ? null : explicit.trim();
  }
  return CLASH_PROXY; // 缺省：直连重试用尽才回落 clash
})();

// ── 看门狗：任何情况下本进程不得超过 WATCHDOG_MS ─────────────────────────────
// unref：不阻退正常退出（否则脚本跑完后事件循环被这个 timer 吊到超时才散场）；
// 真挂死时事件循环仍活着，到点照常强杀。
setTimeout(() => {
  console.error(`[FAIL] 总时长超过 ${WATCHDOG_MS / 1000}s，强制退出（防调度器管线冻结）`);
  process.exit(1);
}, WATCHDOG_MS).unref();

const stripHtml = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hnItemUrl = (id) => `https://news.ycombinator.com/item?id=${id}`;

/** 以硬超时跑一次核心 https.get。socket timeout + 外挂 timer 双保险，
 *  任何挂法（黑洞 IP / TLS 假死）都保证在 ms 内出结果。 */
function httpsGet(url, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn(v);
    };
    const hardTimer = setTimeout(() => {
      req?.destroy(new Error(`硬超时 ${ms}ms`));
      finish(reject, new Error(`硬超时 ${ms}ms`));
    }, ms);
    try {
      req = https.get(url, { headers: HEADERS, timeout: ms }, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // 排干 body 让连接回池
          return finish(reject, new Error(`HTTP ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => finish(resolve, body));
        res.on('error', (e) => finish(reject, e));
      });
      req.on('timeout', () => req.destroy(new Error(`socket 超时 ${ms}ms`))); // → 'error'
      req.on('error', (e) => finish(reject, e));
    } catch (e) {
      finish(reject, e);
    }
  });
}

/** clash CONNECT 隧道 + 外挂硬超时（到点连控制连接一起杀）。 */
function tunnelFetch(url, ms) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const p = new URL(PROXY);
    let settled = false;
    let activeSocket = null;
    let connectReq = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn(v);
    };
    const hardTimer = setTimeout(() => {
      connectReq?.destroy();
      activeSocket?.destroy();
      finish(reject, new Error(`代理硬超时 ${ms}ms`));
    }, ms);

    connectReq = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${u.hostname}:443`,
      headers: { Host: `${u.hostname}:443` },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return finish(reject, new Error(`代理 CONNECT 失败: ${res.statusCode}`));
      }
      activeSocket = socket;
      const req = https.request(
        url,
        {
          method: 'GET',
          headers: HEADERS,
          agent: false,
          createConnection: () => tls.connect({ socket, servername: u.hostname }),
        },
        (r) => {
          if (r.statusCode !== 200) {
            r.destroy();
            return finish(reject, new Error(`HTTP ${r.statusCode}`));
          }
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (c) => (body += c));
          r.on('end', () => finish(resolve, body));
          r.on('error', (e) => finish(reject, e));
        },
      );
      req.on('error', (e) => finish(reject, e));
      req.end();
    });
    connectReq.on('error', (e) => finish(reject, e));
    connectReq.end();
  });
}

/**
 * 单请求最终入口：直连两次（每次都是新 DNS 掷骰，换 IP 即活）→ clash 隧道一次。
 * 全部有硬超时，最坏 2×DIRECT_MS + TUNNEL_MS 内出结果，永不悬死。
 */
async function fetchTextHard(url) {
  const attempts = [
    ['direct', DIRECT_MS],
    ['direct', DIRECT_MS],
    ...(PROXY !== null ? [['tunnel', TUNNEL_MS]] : []),
  ];
  let lastErr;
  for (const [via, ms] of attempts) {
    try {
      return via === 'direct' ? await httpsGet(url, ms) : await tunnelFetch(url, ms);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 简易并发池：按 CONCURRENCY 分批跑（保序，失败返回 null 由调用方过滤） */
async function pool(inputs, worker) {
  const out = new Array(inputs.length);
  for (let i = 0; i < inputs.length; i += CONCURRENCY) {
    const batch = inputs.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (input, j) => {
        out[i + j] = await worker(input, i + j).catch(() => null);
      }),
    );
  }
  return out;
}

/** 拉一条榜单的 id 列表 */
async function fetchStoryIds(url) {
  const ids = JSON.parse(await fetchTextHard(url));
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('id 列表异常（空或非数组）');
  return ids;
}

/** 拉单条故事并归一化成与其他源同构的条目 */
async function fetchItem(id, rank) {
  const it = JSON.parse(await fetchTextHard(`${API}/item/${id}.json`));
  if (!it || it.dead || it.deleted) return null; // 榜单 id 偶有已删除条目
  const title = String(it.title ?? '').trim();
  if (!title) return null;
  const discussion = hnItemUrl(it.id);
  const comments = Number.isFinite(it.descendants) ? it.descendants : 0;
  return {
    id: String(it.id), // HN 数字 id，跨轮次稳定（打标/推荐流对齐主键）
    type: 'story',
    rank,
    title,
    excerpt: it.text ? stripHtml(it.text).slice(0, 300) : '',
    heat: Number.isFinite(it.score) ? it.score : 0,
    comments,
    author: { name: String(it.by ?? '').trim() || 'Hacker News' },
    url: String(it.url ?? '').trim() || discussion, // 无外链的故事（Ask HN 等）落讨论页
    hn_url: discussion, // 讨论页（外链故事的评论区）
    created_time: Number.isFinite(it.time) ? it.time : null, // Unix 秒，与知乎口径一致
    updated_time: null,
  };
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  console.log(`[INFO] 抓取 Hacker News 榜单（top/best 各 ${LIMIT} 条）`);

  const feeds = [];
  for (const [source, url] of Object.entries(FEEDS)) {
    try {
      const ids = (await fetchStoryIds(url)).slice(0, LIMIT);
      const items = (await pool(ids, (id, i) => fetchItem(id, i + 1))).filter(Boolean);
      if (items.length === 0) throw new Error('没有解析到任何条目');
      feeds.push({ source, method: 'firebase-api', count: items.length, items });
      console.log(`[OK] ${source}: ${items.length} 条（榜首: ${items[0].title}）`);
    } catch (e) {
      // 单流失败不拖垮另一流（下次调度自动重试），全部失败才退出非零
      console.error(`[WARN] ${source} 流抓取失败: ${e.message}`);
    }
  }

  if (feeds.length === 0) {
    console.error('[FAIL] top/best 全部抓取失败，不写出产物（保留上一次同步的数据）');
    process.exit(1);
  }

  const result = {
    scraped_at: new Date().toISOString(),
    feeds,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[DONE] 输出: ${OUT}`);
})();
