import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// bilibili-feed.mjs — 抓取 B 站视频流（热门/排行榜/首页推荐）输出 JSON
// 用法: node bilibili-feed.mjs [--tabs popular,rank,home] [--screens 3] [--out <path>]
//
// 与 zhihu-feed.mjs 同一套思路：Playwright 打开页面滚动，拦截页面发出的
// bilibili API JSON 响应。popular / rank 公开无需登录；home 匿名也有推荐流。
// 若存在 storage/bilibili-state.json（可用 zhihu 同款扫码方式另存）则自动
// 携带登录态，首页推荐会变成个性化流；没有也不报错。

// 以脚本自身位置定位，无论从哪个 cwd 调用（手动 / 调度器）都成立
const ROOT = import.meta.dirname;
const STATE = path.join(ROOT, "storage/bilibili-state.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
  popular: { url: "https://www.bilibili.com/v/popular/all", api: "web-interface/popular", wait: ".feed-card" },
  rank: { url: "https://www.bilibili.com/v/popular/rank/all", api: "web-interface/ranking", wait: ".rank-list" },
  home: { url: "https://www.bilibili.com/", api: "feed/rcmd", wait: ".bili-feed4" },
};

const stripHtml = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/** 从 bilibili API 响应体里防御性地抠出条目数组（popular/rank 是 data.list，rcmd 是 data.item(s)） */
function extractList(body) {
  const d = body?.data;
  if (!d || typeof d !== "object") return [];
  if (Array.isArray(d.list)) return d.list;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.item)) return d.item;
  if (Array.isArray(body.list)) return body.list;
  return [];
}

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
  const raw = [];
  page.on("response", async (res) => {
    try {
      if (!res.url().includes(def.api)) return;
      const ct = res.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      const body = await res.json().catch(() => null);
      if (!body || body.code !== 0) return;
      for (const it of extractList(body)) raw.push(it);
    } catch {}
  });

  await gotoWithRetry(page, def.url);
  await page.waitForSelector(def.wait, { timeout: 15000 }).catch(() => {}); // 选择器尽力而为，抓不到就纯靠滚动+拦截
  for (let i = 0; i < SCREENS; i++) {
    await page.mouse.wheel(0, 2600);
    await page.waitForTimeout(1400 + Math.random() * 900);
  }
  await page.waitForTimeout(800);
  // 兜底：首页推荐流是懒加载，拦截不一定触发，直接在页面上下文里 fetch（自带 cookie/referer，免 wbi 签名）
  if (tabName === "home" && raw.length === 0) {
    const fetched = await page
      .evaluate(
        async () =>
          (
            await (
              await fetch(
                "https://api.bilibili.com/x/web-interface/index/top/feed/rcmd?ps=12&fresh_idx=1&fresh_idx_1h=1&fresh_type=4&feed_version=V8",
                { credentials: "include" }
              )
            ).json()
          )?.data?.item ?? []
      )
      .catch(() => []);
    raw.push(...fetched);
  }
  const items = dedupe(raw.map((it) => normApiItem(it, type)).filter(Boolean));
  return { source: tabName, method: "api-intercept", count: items.length, items };
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...(fs.existsSync(STATE) ? { storageState: STATE } : {}),
    viewport: { width: 1920, height: 1080 },
    userAgent: UA,
    locale: "zh-CN",
  });

  const result = { scraped_at: new Date().toISOString(), screens: SCREENS, feeds: [] };

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
