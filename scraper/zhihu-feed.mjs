import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// zhihu-feed.mjs — 抓取知乎信息流（推荐/关注/热榜）输出 JSON
// 用法: node zhihu-feed.mjs [--tabs recommend,follow,hot] [--screens 3] [--out <path>]

// 以脚本自身位置定位，无论从哪个 cwd 调用（手动 / 调度器）都成立
const ROOT = import.meta.dirname;
const STATE = path.join(ROOT, "storage/zhihu-state.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
function argOf(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const TABS = argOf("--tabs", "recommend,follow,hot").split(",");
const SCREENS = parseInt(argOf("--screens", "3"), 10);
const OUT =
  argOf("--out", "") ||
  path.join(ROOT, "output", `zhihu-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);

const TAB_DEFS = {
  recommend: { url: "https://www.zhihu.com/", api: "feed/topstory/recommend", wait: ".ContentItem" },
  follow: { url: "https://www.zhihu.com/follow", api: "/api/v3/moments", wait: ".ContentItem" },
  hot: { url: "https://www.zhihu.com/hot", api: null, wait: ".HotItem" },
};

const stripHtml = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

function buildUrl(type, t, id) {
  const qid = t?.question?.id;
  switch (type) {
    case "answer":
      return qid ? `https://www.zhihu.com/question/${qid}/answer/${id}` : "";
    case "article":
      return `https://zhuanlan.zhihu.com/p/${id}`;
    case "pin":
      return `https://www.zhihu.com/pin/${id}`;
    case "question":
      return id ? `https://www.zhihu.com/question/${id}` : "";
    case "zvideo":
    case "video":
      return t?.video?.url || "";
    default:
      return (t?.url || "").replace("https://api.zhihu.com", "https://www.zhihu.com");
  }
}

function normApiItem(it) {
  if (!it || typeof it !== "object") return null;
  const t = it.target && typeof it.target === "object" ? it.target : it;
  let briefType = "";
  let briefId = "";
  try {
    if (typeof it.brief === "string") {
      const b = JSON.parse(it.brief);
      briefType = b.type || "";
      briefId = String(b.id || "");
    }
  } catch {}
  const type = String(t.type || briefType || "unknown").toLowerCase();
  if (type.includes("advert") || type === "feed_group" || type === "unknown") return null;
  const id = String(t.id ?? briefId ?? it.id ?? "");
  const title =
    stripHtml(t.title) ||
    stripHtml(t.question?.title) ||
    stripHtml(typeof t.content === "string" ? t.content : "").slice(0, 80);
  const excerpt =
    stripHtml(t.excerpt) ||
    stripHtml(t.excerpt_new) ||
    stripHtml(t.content_text) ||
    stripHtml(typeof t.content === "string" ? t.content : "").slice(0, 200) ||
    stripHtml(Array.isArray(t.content) ? t.content.map((c) => c.content || "").join(" ") : "");
  const finalTitle = title || excerpt.slice(0, 60);
  const authorName = t.author?.name || "";
  const authorUrl = (t.author?.url || "").replace("https://api.zhihu.com", "https://www.zhihu.com");
  return {
    id,
    type,
    title: finalTitle,
    excerpt: excerpt.slice(0, 300),
    author: authorName ? { name: authorName, url: authorUrl } : null,
    url: buildUrl(type, t, id),
    voteup: t.voteup_count ?? null,
    comment_count: t.comment_count ?? null,
    created_time: t.created_time ?? t.created ?? null,
    updated_time: t.updated_time ?? t.updated ?? null,
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

async function scrapeApiTab(page, def, tabName) {
  const raw = [];
  page.on("response", async (res) => {
    try {
      if (!res.url().includes(def.api)) return;
      const ct = res.headers()["content-type"] || "";
      if (!ct.includes("json")) return;
      const body = await res.json().catch(() => null);
      if (!body) return;
      const arr = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
      for (const it of arr) raw.push(it);
    } catch {}
  });

  await page.goto(def.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(def.wait, { timeout: 15000 }).catch(() => {});
  for (let i = 0; i < SCREENS; i++) {
    await page.mouse.wheel(0, 2600);
    await page.waitForTimeout(1400 + Math.random() * 900);
  }
  await page.waitForTimeout(800);
  const items = dedupe(raw.map(normApiItem).filter(Boolean));
  return { source: tabName, method: "api-intercept", count: items.length, items };
}

async function scrapeHotTab(page) {
  await page.goto(TAB_DEFS.hot.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".HotItem", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 2600);
    await page.waitForTimeout(1200 + Math.random() * 600);
  }
  const items = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".HotItem").forEach((el, idx) => {
      const a = el.querySelector("a[href*='/question/'], h2 a");
      const title = el.querySelector(".HotItem-title")?.innerText?.trim() || a?.innerText?.trim() || "";
      const excerpt = el.querySelector(".HotItem-excerpt")?.innerText?.trim() || "";
      const metrics = el.querySelector(".HotItem-metrics")?.innerText?.trim() || "";
      let url = a?.href || "";
      if (url.startsWith("/")) url = "https://www.zhihu.com" + url;
      const m = url.match(/question\/(\d+)/);
      const heat = (metrics.match(/([\d.]+\s*[万亿]?)\s*热度/) || [])[1] || null;
      out.push({
        rank: idx + 1,
        id: m ? m[1] : String(idx + 1),
        type: "hot",
        title,
        excerpt: excerpt.slice(0, 300),
        author: null,
        url,
        heat,
        voteup: null,
        comment_count: null,
        created_time: null,
        updated_time: null,
      });
    });
    return out;
  });
  return { source: "hot", method: "dom-extract", count: items.length, items };
}

(async () => {
  if (!fs.existsSync(STATE)) {
    console.error("登录态不存在，请先完成扫码登录");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: STATE,
    viewport: { width: 1920, height: 1080 },
    userAgent: UA,
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
      const feed = def.api ? await scrapeApiTab(page, def, tabName.trim()) : await scrapeHotTab(page);
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
