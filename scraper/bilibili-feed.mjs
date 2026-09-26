import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// bilibili-feed.mjs — 抓取 B 站视频流（热门/排行榜/首页推荐）输出 JSON
// 用法: node bilibili-feed.mjs [--tabs popular,rank,home] [--screens 3] [--out <path>]
//
// 通过 lightpanda（CDP 9222）打开页面获取 cookie 上下文，再在页面内 fetch
// bilibili API 直接取数。popular / rank 公开无需登录；home 匿名也有推荐流。
// 若存在 storage/bilibili-state.json（可用 zhihu 同款扫码方式另存）则自动
// 携带登录态，首页推荐会变成个性化流；没有也不报错。

// 以脚本自身位置定位，无论从哪个 cwd 调用（手动 / 调度器）都成立
const ROOT = import.meta.dirname;
const STATE = path.join(ROOT, "storage/bilibili-state.json");

const args = process.argv.slice(2);
function argOf(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const TABS = argOf("--tabs", "popular,rank,home").split(",");
const SCREENS = parseInt(argOf("--screens", "3"), 10);
const OUT =
  argOf("--out", "") ||
  path.join(ROOT, "output", `bilibili-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);

const TAB_DEFS = {
  popular: {
    url: "https://www.bilibili.com/v/popular/all",
    apiUrl: (page) => `https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${page}`,
  },
  rank: {
    url: "https://www.bilibili.com/v/popular/rank/all",
    apiUrl: () => "https://api.bilibili.com/x/web-interface/ranking/v2",
  },
  home: {
    url: "https://www.bilibili.com/",
    apiUrl: (page) =>
      `https://api.bilibili.com/x/web-interface/index/top/feed/rcmd?ps=12&fresh_idx=${page}&fresh_idx_1h=${page}&fresh_type=4&feed_version=V8`,
  },
};

const stripHtml = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/** bilibili API 条目 → 与知乎条目同构的轻量结构（id/type/title/excerpt/author/url/…） */
function normApiItem(it, type) {
  if (!it || typeof it !== "object") return null;
  const id = String(it.aid ?? it.id ?? it.bvid ?? "");
  if (!id) return null;
  const bvid = String(it.bvid || "");
  const stat = it.stat && typeof it.stat === "object" ? it.stat : {};
  const owner = it.owner && typeof it.owner === "object" ? it.owner : {};
  const title = stripHtml(it.title);
  if (!title) return null;
  const created =
    typeof it.pubdate === "number"
      ? it.pubdate
      : it.create
        ? Math.round(Date.parse(it.create) / 1000) || null
        : null;
  return {
    id,
    type,
    title,
    excerpt: stripHtml(it.desc).slice(0, 300),
    author: owner.name
      ? { name: owner.name, url: owner.mid ? `https://space.bilibili.com/${owner.mid}` : "" }
      : null,
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : String(it.short_link_v2 || ""),
    voteup: stat.like ?? null,
    comment_count: stat.reply ?? null,
    view: stat.view ?? null,
    danmaku: stat.danmaku ?? null,
    duration: it.duration ?? null,
    pic: it.pic ?? null,
    tname: it.tname ?? null,
    bvid: bvid || null,
    rank: typeof it.rank === "number" ? it.rank : null,
    score: typeof it.score === "number" ? it.score : null,
    created_time: created,
    updated_time: null,
  };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.url || `${it.type}:${it.id}`;
    if (!key || key === ":" || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function importCookies(context, statePath, origin) {
  if (!fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (!state.cookies?.length) return;
  const setup = await context.newPage();
  await setup.goto(origin, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await context.addCookies(state.cookies);
  await setup.close();
}

async function detectLoginRequired(context) {
  if (!fs.existsSync(STATE)) {
    return { required: false, reason: "" };
  }

  const page = await context.newPage();
  try {
    await page.goto("https://api.bilibili.com/x/web-interface/nav", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    const body = await page.evaluate(() => {
      try { return JSON.parse(document.body.innerText); } catch { return null; }
    });
    if (body?.data?.isLogin === false) {
      return { required: true, reason: "B站登录态失效，个性化首页无法使用" };
    }
    return { required: false, reason: "" };
  } catch (e) {
    return { required: false, reason: `B站登录态检查失败：${e.message.split("\n")[0]}` };
  } finally {
    await page.close();
  }
}

/** 打开页面：超时自动重试一次（B 站热门页偶发首屏慢，重试即可恢复） */
async function gotoWithRetry(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.log(`[WARN] 首次打开超时，重试: ${e.message.split("\n")[0]}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  }
}

async function scrapeApiTab(page, def, tabName, type) {
  await gotoWithRetry(page, def.url);
  await page.waitForTimeout(2000);

  const pageCount = tabName === "rank" ? 1 : SCREENS;
  const urls = Array.from({ length: pageCount }, (_, i) => def.apiUrl(i + 1));

  const raw = await page
    .evaluate(async (urls) => {
      const results = [];
      for (const url of urls) {
        const res = await fetch(url, { credentials: "include" });
        const body = await res.json();
        if (body.code !== 0) continue;
        const items = body.data?.list ?? body.data?.item;
        if (Array.isArray(items)) results.push(...items);
      }
      return results;
    }, urls)
    .catch(() => []);

  const items = dedupe(raw.map((it) => normApiItem(it, type)).filter(Boolean));
  return { source: tabName, method: "api-fetch", count: items.length, items };
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0] ?? (await browser.newContext());
  await importCookies(context, STATE, "https://www.bilibili.com/");

  const login = await detectLoginRequired(context);
  const result = {
    scraped_at: new Date().toISOString(),
    screens: SCREENS,
    login_required: login.required,
    login_reason: login.reason,
    feeds: [],
  };

  for (const tabName of TABS) {
    const def = TAB_DEFS[tabName.trim()];
    if (!def) {
      console.log(`[SKIP] 未知 tab: ${tabName}`);
      continue;
    }
    const page = await context.newPage();
    console.log(`[INFO] 抓取 ${tabName} → ${def.url}`);
    try {
      const feed = await scrapeApiTab(page, def, tabName.trim(), tabName.trim() === "rank" ? "rank" : "video");
      result.feeds.push(feed);
      console.log(`[OK] ${tabName}: ${feed.count} 条 (${feed.method})`);
    } catch (e) {
      console.error(`[FAIL] ${tabName}: ${e.message}`);
      result.feeds.push({ source: tabName.trim(), error: e.message, count: 0, items: [] });
    }
    await page.close();
    await page.waitForTimeout(1500).catch(() => {});
  }

  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[DONE] 输出: ${OUT}`);
  result.feeds.forEach((f) => console.log(`  - ${f.source}: ${f.count} 条${f.error ? " (error: " + f.error + ")" : ""}`));
})();
