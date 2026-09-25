#!/usr/bin/env node
/**
 * hn-summarizer.mjs — 为 Hacker News 条目翻译标题、生成中文摘要（全文翻译按需）。
 *
 * 流程：读 public/data/hn-feed.json → 找待处理条目 → 取正文：
 *   - Ask HN 类自述：抓取时已留在 item.text（见 hn-hot.mjs），直接用；
 *   - 外链故事：抓原文网页，剥出正文文本（article/main 优先，兜底全页）。
 * → 优先调本地 Argos/CTranslate2 模型：标题完整翻译，摘要用正文开头节选译文。
 *   本地模型不做生成式概括；本地失败时回退智谱生成 3~6 句中文摘要。
 * → 存摘要库（storage/hn-summaries.json，独立持久化防覆盖），连同**原文正文**
 *   （entry.content）与原文链接（entry.url）一起落库 → 注入回数据文件的
 *   item.summary / item.title_zh / item.content_zh。
 *
 * 全文翻译不在批处理里做（本地 CPU 吞吐有限，批量翻译整版榜单会拖慢管线）：
 * APK 卡片上有「翻译全文」按钮，点击时调 POST /api/hn/translate 现翻，
 * API 优先用摘要库里的 entry.content 秒翻（无需重新抓页面），译文写回摘要库，
 * 下次点击（及之后每一轮的 feed 注入）直接复用。存量已翻好的 content_zh 照常注入。
 *
 * 幂等与升级：摘要库按 HN 数字 id 索引，榜单轮换/重新抓取不丢。条目级进度标记：
 *   - 无摘要条目               → 摘要 + 原文落库；
 *   - 有摘要但缺 content 字段   → 只补抓原文落库（旧版本摘要库自动升级，无 LLM 成本）；
 *   - content 为空串           → 试过但抓不到正文（付费墙/JS 渲染页），不再重试；
 *     点击翻译时 API 会用 entry.url 再现场抓一次，仍失败才报错。
 * 超过 STORE_TTL_DAYS 的旧条目清理（HN 榜单几小时内大换血，老条目基本不会复榜）。
 *
 * 用法:
 *   npm run summarize:hn
 *   SUMMARY_LIMIT=3 npm run summarize:hn   # 本次最多处理 N 条（试跑用）
 *
 * 环境变量: LOCAL_TRANSLATE_URL / LOCAL_SUMMARY_CHARS；
 *   GLM 兜底仍用 ZHIPU_API_KEY / ZHIPU_MODEL / ZHIPU_BASE_URL。
 */
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { MODEL, chatComplete, resolveApiKey } from './zhipu.mjs';
import { fetchArticleText, MAX_PAGE_CHARS } from './article-text.mjs';
import { applySummaries, loadSummaryStore, saveSummaryStore } from './summary-store.mjs';
import { LOCAL_TRANSLATE_MODEL, looksChinese, translateLocal } from './local-translate.mjs';

const ROOT = import.meta.dirname;
const PREFIX = '[summarize:hn]';
const FEED_FILE = path.resolve(ROOT, '..', 'public', 'data', 'hn-feed.json');
const HN_HOST = 'news.ycombinator.com'; // 讨论页 URL，抓了也只有标题列表，跳过
const API_CONCURRENCY = Math.max(1, Number(process.env.SUMMARY_CONCURRENCY ?? 3) || 3);
const LOCAL_TRANSLATE_URL = process.env.LOCAL_TRANSLATE_URL || 'http://127.0.0.1:8788/translate';
const LOCAL_TRANSLATE_ENABLED = process.env.LOCAL_TRANSLATE_URL !== '';
const LOCAL_SUMMARY_CHARS = Math.max(300, Number(process.env.LOCAL_SUMMARY_CHARS ?? 900) || 900);
const STORE_MODEL = LOCAL_TRANSLATE_ENABLED ? LOCAL_TRANSLATE_MODEL : MODEL;
const LIMIT = Math.max(0, Number(process.env.SUMMARY_LIMIT ?? 0) || 0); // 0 = 不限制
const STORE_TTL_DAYS = 30; // 摘要库条目保留期，过期清理
// 进程级看门狗：调度器 spawnSync 无超时，本脚本挂住 = 整条抓取管线冻结。
// 不再批量翻译正文后，最坏 ≈ 条数×(抓页 15s + 摘要 200s)/并发；30 分钟绰绰有余。
const WATCHDOG_MS = 30 * 60_000;

setTimeout(() => {
  console.error(`${PREFIX} 总时长超过 ${WATCHDOG_MS / 60_000} 分钟，强制退出（防调度器管线冻结）`);
  process.exit(1);
}, WATCHDOG_MS).unref();

const SYSTEM_PROMPT =
  '你是科技资讯编辑。输入是一条 Hacker News 条目的英文标题和可选的正文节选。完成两件事：' +
  '1. 把标题翻译成简体中文（专有名词/项目名/公司名保留原文）；' +
  '2. 有正文时根据正文写一段简体中文介绍（它说了什么、为什么值得看）；' +
  '没有正文时只根据标题用一两句话说明这条内容大概是什么，不要编造细节。' +
  '只输出一个 JSON 对象：{"title_zh": "中文标题", "summary": "中文介绍"}，' +
  '不要 Markdown 代码块标记，不要任何解释。';

// ---------- LLM：标题翻译+摘要（一次调用） ----------

/** 从模型输出里抠 JSON 对象（容忍 ```json 围栏和前后废话）；失败返回 null */
function parseLlmJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

async function translateAndSummarize(item, content, apiKey) {
  const userMsg =
    `标题：${item.title}\n` +
    (item.url && !item.url.includes(HN_HOST) ? `原文链接：${item.url}\n` : '') +
    (content ? `\n正文节选：\n${content}` : '\n（没有抓到正文，只根据标题说明）');
  const res = await chatComplete({
    apiKey,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.3,
    max_tokens: 600,
  });
  const parsed = parseLlmJson(res);
  if (!parsed) throw new Error(`输出不是合法 JSON：${res.slice(0, 80)}`);
  const titleZh = String(parsed.title_zh ?? '').replace(/^["'「『]+|["'」』]+$/g, '').trim();
  const summary = String(parsed.summary ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!titleZh) throw new Error('缺少 title_zh');
  if (summary.length < 5 || summary.length > 1200) throw new Error(`摘要长度异常 (${summary.length} 字)`);
  return { title_zh: titleZh.slice(0, 300), summary };
}

/** 本地模式不生成概括，只翻译标题；有正文时用开头节选的中文译文作介绍。 */
async function translateAndSummarizeLocally(item, content) {
  const titleZh = looksChinese(item.title)
    ? item.title.trim()
    : await translateLocal(item.title, { endpoint: LOCAL_TRANSLATE_URL, timeoutMs: 30_000 });

  let summary = titleZh;
  if (content) {
    const paragraphs = content
      .split(/\n+/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length >= 80);
    const suspicious = /image credit|share|facebook|whatsapp|reddit|newsletter|subscribe|sign in|advertisement/i;
    const meaningful = paragraphs.filter((paragraph) => !suspicious.test(paragraph));
    const excerpt = (meaningful[0] ?? paragraphs[0] ?? content).slice(0, LOCAL_SUMMARY_CHARS);
    summary = looksChinese(excerpt)
      ? excerpt.replace(/\s*\n+\s*/g, ' ').trim()
      : await translateLocal(excerpt, { endpoint: LOCAL_TRANSLATE_URL, timeoutMs: 100_000 });
  }
  if (summary.length < 5) throw new Error(`本地摘要长度异常 (${summary.length} 字)`);
  return {
    title_zh: titleZh.slice(0, 300),
    summary: summary.slice(0, 1200),
    model: LOCAL_TRANSLATE_MODEL,
  };
}

// ---------- 摘要库清理 ----------

/** 丢弃超过保留期的旧条目（榜单几小时大换血，老条目基本不会复榜） */
function pruneStore(store) {
  const cutoff = Date.now() - STORE_TTL_DAYS * 24 * 3600 * 1000;
  let removed = 0;
  for (const [id, entry] of store) {
    const at = Date.parse(entry.summarized_at ?? '') || 0;
    if (at && at < cutoff) {
      store.delete(id);
      removed++;
    }
  }
  return removed;
}

/** 简单并发池（同 tagger/github-summarizer） */
async function runPool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        await fn(items[idx], idx);
      }
    }),
  );
}

async function main() {
  const t0 = Date.now();
  const apiKey = await resolveApiKey();

  let feed;
  try {
    feed = JSON.parse(await readFile(FEED_FILE, 'utf8'));
  } catch (e) {
    console.error(`${PREFIX} 读取 ${FEED_FILE} 失败：${e.message}（先跑 npm run scrape:hn）`);
    process.exit(1);
  }

  const store = await loadSummaryStore('hn');
  const pruned = pruneStore(store);

  // 按 id 去重收集待处理条目（top/best 有重叠）：
  //   无摘要 → 摘要+原文落库；有摘要但缺 content 字段 → 只补原文（旧库自动升级）
  const allIds = new Set();
  const pending = [];
  const seen = new Set();
  for (const f of feed.feeds ?? []) {
    for (const it of f.items ?? []) {
      const id = String(it.id ?? '');
      if (!id) continue;
      allIds.add(id);
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = store.get(id);
      const needsSummary = !entry;
      const needsContent = !entry || !('content' in entry);
      if (!needsSummary && !needsContent) continue;
      pending.push({
        id,
        title: String(it.title ?? id),
        url: typeof it.url === 'string' ? it.url : '',
        text: typeof it.text === 'string' ? it.text : '', // Ask HN 自述全文（hn-hot.mjs）
        entry, // 已有条目（补原文场景）或 undefined
        needsSummary,
        needsContent,
      });
    }
  }
  const batch = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;

  const toSummarize = batch.filter((i) => i.needsSummary).length;
  const toUpgrade = batch.length - toSummarize;
  console.log(
    `${PREFIX} 共 ${allIds.size} 条，摘要库已有 ${store.size} 条（清理过期 ${pruned} 条），` +
      `待处理 ${batch.length} 条（需摘要 ${toSummarize}，补存原文 ${toUpgrade}），` +
      `模型 ${LOCAL_TRANSLATE_ENABLED ? `${LOCAL_TRANSLATE_MODEL}（GLM 兜底）` : MODEL}`,
  );
  if (batch.length === 0) {
    const injected = applySummaries(feed, store);
    await mkdir(path.dirname(FEED_FILE), { recursive: true });
    await writeFile(FEED_FILE, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
    await chmod(FEED_FILE, 0o644);
    if (pruned > 0) await saveSummaryStore(store, { model: STORE_MODEL, source: 'hn' });
    console.log(`${PREFIX} 没有新增条目，数据文件已注入摘要 ${injected} 条`);
    return;
  }

  // 阶段一：取正文（Ask HN 用现成 text，外链抓原文网页）
  let fetched = 0;
  await runPool(batch, API_CONCURRENCY, async (it) => {
    if (it.text) {
      it.content = it.text.slice(0, MAX_PAGE_CHARS);
    } else if (it.url && !it.url.includes(HN_HOST)) {
      it.content = await fetchArticleText(it.url);
    } else {
      it.content = '';
    }
    fetched++;
    process.stdout.write(`\r${PREFIX} 取正文 ${fetched}/${batch.length}`);
  });
  process.stdout.write('\n');
  const withContent = batch.filter((i) => i.content).length;

  // 阶段二：本地优先摘要/翻译（只有缺摘要的条目处理），连同原文/链接一起落库
  let done = 0;
  let failed = 0;
  await runPool(batch, API_CONCURRENCY, async (it) => {
    if (it.needsSummary) {
      try {
        let result;
        if (LOCAL_TRANSLATE_ENABLED) {
          try {
            result = await translateAndSummarizeLocally(it, it.content);
          } catch (localError) {
            console.warn(`  ↻ [本地失败] ${it.title.slice(0, 40)}… → ${localError.message}，改用 GLM`);
          }
        }
        result ??= await translateAndSummarize(it, it.content, apiKey);
        it.entry = {
          title_zh: result.title_zh,
          summary: result.summary,
          lang: 'zh',
          summarized_at: new Date().toISOString(),
          model: result.model ?? MODEL,
          content: it.content, // 原文落库：点击「翻译全文」时 API 直接用，不再重抓页面
          url: it.url,
        };
      } catch (e) {
        failed++;
        console.warn(`  ✗ [摘要] ${it.title.slice(0, 40)}… → ${e.message}（下次运行会重试）`);
        return; // 摘要没成不落库（loadSummaryStore 只认带 summary 的条目），下轮连原文一起重来
      }
    } else if (it.entry) {
      // 旧库升级：只补原文与链接，零 LLM 成本
      it.entry = { ...it.entry, content: it.entry.content ?? it.content, url: it.entry.url ?? it.url };
    }
    store.set(it.id, it.entry);
    done++;
    console.log(
      `  ✓ [${done}/${batch.length}] ${it.title.slice(0, 36)}…\n` +
        `      → ${it.entry.title_zh?.slice(0, 36)}｜${it.entry.summary.slice(0, 44)}…` +
        (it.entry.content ? `｜原文 ${it.entry.content.length} 字` : '｜无正文'),
    );
    if (done % 5 === 0) await saveSummaryStore(store, { model: STORE_MODEL, source: 'hn' });
  });

  if (done > 0 || pruned > 0) await saveSummaryStore(store, { model: STORE_MODEL, source: 'hn' });

  // 注入回数据文件（无论本次有没有新增，都保证文件与摘要库同步；
  // 存量 content_zh 译文照常注入——点过「翻译全文」的条目下次直接带全文）
  const injected = applySummaries(feed, store);
  await writeFile(FEED_FILE, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
  await chmod(FEED_FILE, 0o644); // NAS 权限保护层：防止 nginx 容器 403

  console.log(
    `${PREFIX} 完成：成功 ${done}，失败 ${failed}，有正文 ${withContent}/${batch.length}` +
      `，数据文件已注入摘要 ${injected} 条（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );
  if (failed > 0 && done === 0) process.exit(1);
}

main();
