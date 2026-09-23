import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// zhihu-feed.mjs — 抓取知乎信息流（推荐/关注/热榜）输出 JSON
// 用法: node zhihu-feed.mjs [--tabs recommend,follow,hot] [--screens 3] [--out <path>]

// 通过 lightpanda（CDP 9222）打开页面获取登录态，推荐/关注用 DOM 提取，
// 热榜直接在页面内 fetch API 取数。

// 以脚本自身位置定位，无论从哪个 cwd 调用（手动 / 调度器）都成立
const ROOT = import.meta.dirname;
const STATE = path.join(ROOT, "storage/zhihu-state.json");

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

function parseCnNumber(text, suffix) {
  const match = text.match(new RegExp(`([\\d,.]+)\\s*([万亿]?)\\s*${suffix}`));
  if (!match) return null;
  const num = parseFloat(match[1].replace(/,/g, ""));
  if (match[2] === "万") return Math.round(num * 10000);
  if (match[2] === "亿") return Math.round(num * 100000000);
  return Math.round(num);
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

async function scrapeApiTab(page, def, tabName) {
  await page.goto(def.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(def.wait, { timeout: 15000 }).catch(() => {});
  for (let i = 0; i < SCREENS; i++) {
    await page.mouse.wheel(0, 2600);
    await page.waitForTimeout(1400 + Math.random() * 900);
  }
  await page.waitForTimeout(800);

  const raw = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".ContentItem").forEach((el) => {
      let meta = {};
      try { meta = JSON.parse(el.getAttribute("data-zop") || "{}"); } catch {}
      const titleEl = el.querySelector(".ContentItem-title a, h2 a");
      const excerptEl = el.querySelector(".RichContent-inner .RichText, .ContentItem-excerpt");
      const authorEl = el.querySelector(".AuthorInfo-name a, .AuthorInfo-name");
      const timeEl = el.querySelector(".ContentItem-time");
      const voteBtn = el.querySelector(".VoteButton--up");
      let url = titleEl?.href || "";
      if (url.startsWith("/")) url = "https://www.zhihu.com" + url;
      const qid = (url.match(/question\/(\d+)/) || [])[1];
      const aid = (url.match(/answer\/(\d+)/) || [])[1];
      const type = meta.type || (aid ? "answer" : qid ? "question" : "article");
      const id = String(meta.itemId || aid || qid || "");
      if (!id && !url) return;
      const voteMatch = (voteBtn?.innerText || "").match(/([\d,.]+)\s*([万亿]?)/);
      const voteup = voteMatch
        ? Math.round(parseFloat(voteMatch[1].replace(/,/g, "")) * (voteMatch[2] === "万" ? 10000 : voteMatch[2] === "亿" ? 100000000 : 1))
        : null;
      out.push({
        id,
        type,
        title: meta.title || titleEl?.innerText?.trim() || "",
        excerpt: (excerptEl?.innerText || "").trim().slice(0, 300),
        author: authorEl?.innerText?.trim()
          ? { name: authorEl.innerText.trim(), url: authorEl.href || "" }
          : null,
        url,
        voteup,
        comment_count: null,
        created_time: timeEl ? Date.parse(timeEl.innerText.replace("发布于 ", "").replace("编辑于 ", "")) / 1000 || null : null,
        updated_time: null,
      });
    });
    return out;
  });

  const items = dedupe(raw.filter(Boolean));
  return { source: tabName, method: "dom-extract", count: items.length, items };
}

async function scrapeHotTab(page) {
  await page.goto("https://www.zhihu.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  const raw = await page
    .evaluate(async () => {
      const res = await fetch(
        "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50",
        { credentials: "include" }
      );
      return res.json();
    })
    .catch(() => ({ data: [] }));

  const items = (raw?.data ?? []).map((it, idx) => {
    const t = it.target || {};
    const qid = t.id ? String(t.id) : String(idx + 1);
    const heat = parseCnNumber(it.detail_text || "", "热度");
    return {
      rank: idx + 1,
      id: qid,
      type: "hot",
      title: t.title || "",
      excerpt: (t.excerpt || "").slice(0, 300),
      author: null,
      url: t.id ? `https://www.zhihu.com/question/${t.id}` : "",
      heat,
      voteup: null,
      comment_count: null,
      created_time: t.created ?? null,
      updated_time: null,
    };
  });

  return { source: "hot", method: "api-fetch", count: items.length, items };
}

(async () => {
  if (!fs.existsSync(STATE)) {
    console.error("登录态不存在，请先完成扫码登录");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0] ?? (await browser.newContext());
  await importCookies(context, STATE, "https://www.zhihu.com/");

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
