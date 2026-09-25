#!/usr/bin/env node
/**
 * github-summarizer.mjs — 为 GitHub Trending 仓库生成中文介绍摘要。
 *
 * 流程：读 public/data/github-feed.json → 找没有摘要的条目 → 抓仓库 README
 * （优先中文版本，识别规则见 ZH_README_CANDIDATES / looksChinese）→
 * 调智谱 LLM 总结成 ≤10 句话的简体中文介绍 → 存入摘要库
 * （storage/github-summaries.json，独立持久化防覆盖）→ 注入回数据文件的
 * item.summary 字段（前端把摘要当条目摘要展示，库名做标题），README Markdown
 * 全文注入 item.content（前端展开卡片渲染 README，榜单轮换后由缓存重注入）。
 *
 * 幂等：已有摘要的条目直接跳过；README 原文缓存（storage/github-readme-cache.json），
 * LLM 失败的条目下次运行不重新抓 README、只重试总结。
 *
 * 用法:
 *   npm run summarize:github
 *   SUMMARY_LIMIT=3 npm run summarize:github   # 本次最多处理 N 条（试跑用）
 *
 * 环境变量（LLM 部分同 tagger）: ZHIPU_API_KEY / ZHIPU_MODEL / ZHIPU_BASE_URL
 *   GITHUB_TOKEN  可选，配了走认证请求（API 限流 60/h → 5000/h）
 */
import { readFile, writeFile, chmod, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fetchJson, fetchText } from './github-http.mjs';
import { MODEL, chatComplete, resolveApiKey } from './zhipu.mjs';
import { applySummaries, loadSummaryStore, saveSummaryStore } from './summary-store.mjs';

const ROOT = import.meta.dirname;
const PREFIX = '[summarize:github]';
const FEED_FILE = path.resolve(ROOT, '..', 'public', 'data', 'github-feed.json');
const CACHE_FILE = path.join(ROOT, 'storage', 'github-readme-cache.json');
const API_CONCURRENCY = Math.max(1, Number(process.env.SUMMARY_CONCURRENCY ?? 3) || 3);
const LIMIT = Math.max(0, Number(process.env.SUMMARY_LIMIT ?? 0) || 0); // 0 = 不限制
const MAX_README_CHARS = 4000; // 送进 LLM 的 README 节选长度
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const SYSTEM_PROMPT =
  '你是开源项目介绍助手。根据仓库名、一句话简介和 README 节选，用简体中文写一段这个仓库的说明介绍：' +
  '它是做什么的、解决什么问题、有什么核心特性或典型用法。' +
  '要求：不超过 10 句话（通常 3~6 句就够）；通俗准确，突出"能拿它做什么"，不要空话套话；' +
  '不要 Markdown 格式、不要列表符号、不要标题；只输出介绍正文，不要任何解释。';

/** raw 上常见的中文 README 命名（按优先级），不用 API 列目录、不受 60/h 限流 */
const ZH_README_CANDIDATES = [
  'README.zh-CN.md',
  'README_zh-CN.md',
  'README.zh-Hans.md',
  'README_zh-Hans.md',
  'README.zh.md',
  'README_zh.md',
  'README_ZH.md',
  'README.cn.md',
  'docs/README_zh.md',
  'docs/README.zh-CN.md',
  'docs/README.zh.md',
];

/** 中文字符（CJK 统一表意文字）占比是否像中文文档 */
function looksChinese(text) {
  const chars = String(text).replace(/\s/g, '');
  if (!chars) return false;
  const cjk = (chars.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return cjk / chars.length > 0.15;
}

/** 把 README 清洗成适合喂 LLM 的纯文本：去徽章/HTML 注释/标签/图片，保留链接文字 */
function cleanReadme(text) {
  return cleanReadmeSlice(text, MAX_README_CHARS);
}

/** 清洗逻辑与 LLM 输入共用；站内展示可传入无限长度，避免“全文”变成节选 */
function cleanReadmeSlice(text, maxChars) {
  const cleaned = String(text)
    .replace(/<!--[\s\S]*?-->/g, ' ') // HTML 注释（徽章堆常包在里面）
    .replace(/<[^>]+>/g, ' ') // 内联 HTML
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片 ![alt](url)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 [text](url) → text
    .replace(/^\s*(?:[-=*_]{3,}|<br\s*\/?>)\s*$/gim, '') // 分隔线
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
  if (cleaned.length <= maxChars) return cleaned;
  const cut = cleaned.lastIndexOf('\n', maxChars); // 在行边界截断
  return cleaned.slice(0, cut > maxChars / 2 ? cut : maxChars);
}

/** 站内展示保留 Markdown 的标题/链接/图片等结构，只移除容易堆积的 HTML 注释 */
function displayReadme(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, ' ').trim();
}

// ---------- README 原文缓存（LLM 失败重试时不再重抓） ----------

async function loadCache() {
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    return new Map(Object.entries(raw.repos ?? {}));
  } catch {
    return new Map();
  }
}

async function saveCache(cache, currentIds) {
  // 只保留当前在榜仓库的缓存（榜单天然轮换，不清理会无限膨胀）
  const kept = {};
  for (const id of currentIds) {
    if (cache.has(id)) kept[id] = cache.get(id);
  }
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, updated_at: new Date().toISOString(), repos: kept }, null, 2)}\n`, 'utf8');
  await rename(tmp, CACHE_FILE);
  await chmod(CACHE_FILE, 0o644);
}

/** raw 探测单个候选文件：healthy 时亚秒响应，超时收紧到 10s 防 clash 偶发卡顿拖死整体 */
async function tryRaw(owner, name, candidate) {
  try {
    const text = await fetchText(
      `https://raw.githubusercontent.com/${owner}/${name}/HEAD/${candidate}`,
      { 'Accept-Language': 'en,zh;q=0.9' },
      10_000,
    );
    return text?.trim() ? text : null;
  } catch {
    return null; // 404 = 变体不存在；代理/直连失败也当不存在处理
  }
}

/**
 * 抓一个仓库的 README，返回 { path, text, lang }；找不到/失败返回 null。
 * 优先级：中文命名变体（raw，无限流，分块并行探测，命中优先级最高的）→
 * 默认 README（API，能兜住大小写/rst，api.github.com 本机可直连）→ raw README.md 兜底。
 */
async function fetchReadme(id) {
  const [owner, name] = id.split('/');
  for (let i = 0; i < ZH_README_CANDIDATES.length; i += 4) {
    const chunk = ZH_README_CANDIDATES.slice(i, i + 4);
    const results = await Promise.all(chunk.map((c) => tryRaw(owner, name, c)));
    const idx = results.findIndex(Boolean);
    if (idx >= 0) return { path: chunk[idx], text: results[idx], lang: 'zh' };
  }

  const apiHeaders = GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {};
  try {
    const res = await fetchJson(`https://api.github.com/repos/${id}/readme`, apiHeaders);
    const text = Buffer.from(res.content ?? '', 'base64').toString('utf8');
    if (text.trim()) return { path: res.path ?? 'README', text, lang: looksChinese(text) ? 'zh' : 'en' };
  } catch (e) {
    console.warn(`${PREFIX} ${id} 默认 README 获取失败（${e.message}），raw 兜底`);
  }

  const fallback = await tryRaw(owner, name, 'README.md');
  if (fallback) return { path: 'README.md', text: fallback, lang: looksChinese(fallback) ? 'zh' : 'en' };
  return null;
}

/** LLM 总结：≤10 句话兜底裁剪 + 长度校验 */
async function summarize(item, readme, apiKey) {
  const content = await chatComplete({
    apiKey,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `仓库名：${item.id}\n一句话简介：${item.excerpt || '（无）'}\n\nREADME 节选（${readme.path}）：\n${cleanReadme(readme.text)}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 600,
  });
  let summary = content.replace(/\s*\n+\s*/g, ' ').trim();
  // 模型偶尔超句数：按句读截到 10 句
  const sentences = summary.split(/(?<=[。！？!?])/).filter((s) => s.trim());
  if (sentences.length > 10) summary = sentences.slice(0, 10).join('');
  if (summary.length < 10 || summary.length > 900) throw new Error(`摘要长度异常 (${summary.length} 字)`);
  return summary;
}

/** 简单并发池（同 tagger） */
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
    console.error(`${PREFIX} 读取 ${FEED_FILE} 失败：${e.message}（先跑 npm run scrape:github）`);
    process.exit(1);
  }

  const store = await loadSummaryStore('github');
  const cache = await loadCache();

  // 按 id 去重收集没有摘要的条目
  const allIds = new Set();
  const pending = [];
  const seen = new Set();
  for (const f of feed.feeds ?? []) {
    for (const it of f.items ?? []) {
      const id = String(it.id ?? '');
      if (!id) continue;
      allIds.add(id);
      if (store.has(id) || seen.has(id)) continue;
      seen.add(id);
      pending.push({ id, title: String(it.title ?? id), excerpt: typeof it.excerpt === 'string' ? it.excerpt : '' });
    }
  }
  // 预取缓存里已有的 README，先分出「可直接总结」和「要抓 README」的
  for (const it of pending) {
    const hit = cache.get(it.id);
    if (hit?.text) {
      it.readme = hit;
      it.fromCache = true;
    }
  }
  const batch = (LIMIT > 0 ? pending.slice(0, LIMIT) : pending).filter(Boolean);

  console.log(
    `${PREFIX} 共 ${allIds.size} 条，摘要库已有 ${store.size} 条，待处理 ${batch.length} 条` +
      `（其中缓存命中 ${batch.filter((i) => i.fromCache).length} 条）` +
      `，模型 ${MODEL}`,
  );
  if (batch.length === 0) {
    const injected = applySummaries(feed, store);
    const readmeCount = applyReadmes(feed, cache, allIds);
    await writeFile(FEED_FILE, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
    await chmod(FEED_FILE, 0o644);
    console.log(`${PREFIX} 没有新增条目，数据文件已注入摘要 ${injected} 条、README ${readmeCount} 条`);
    return;
  }

  // 阶段一：抓 README（没缓存命中的；并发 3，raw + API 都走代理）
  const toFetch = batch.filter((i) => !i.readme);
  let fetched = 0;
  await runPool(toFetch, API_CONCURRENCY, async (it) => {
    const readme = await fetchReadme(it.id);
    if (readme) {
      it.readme = readme;
      cache.set(it.id, { path: readme.path, lang: readme.lang, text: readme.text, fetched_at: new Date().toISOString() });
    }
    fetched++;
    process.stdout.write(`\r${PREFIX} 抓 README ${fetched}/${toFetch.length}`);
  });
  process.stdout.write('\n');
  await saveCache(cache, allIds);

  // 阶段二：LLM 总结
  const summarizable = batch.filter((i) => i.readme);
  const noReadme = batch.length - summarizable.length;
  let done = 0;
  let failed = 0;
  await runPool(summarizable, API_CONCURRENCY, async (it) => {
    try {
      const summary = await summarize(it, it.readme, apiKey);
      store.set(it.id, {
        summary,
        readme: it.readme.path,
        lang: it.readme.lang,
        summarized_at: new Date().toISOString(),
        model: MODEL,
      });
      done++;
      console.log(`  ✓ [${done}/${summarizable.length}] ${it.id} → ${summary.slice(0, 42)}…`);
    } catch (e) {
      failed++;
      console.warn(`  ✗ ${it.id} → ${e.message}（下次运行会重试，README 已缓存）`);
    }
    if ((done + failed) % 5 === 0) await saveSummaryStore(store, { model: MODEL, source: 'github' });
  });

  if (batch.length > 0) await saveSummaryStore(store, { model: MODEL, source: 'github' });

  // 注入回数据文件（无论本次有没有新增，都保证文件与摘要库同步）
  const injected = applySummaries(feed, store);
  const readmeCount = applyReadmes(feed, cache, allIds);
  await writeFile(FEED_FILE, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
  await chmod(FEED_FILE, 0o644); // NAS 权限保护层：防止 nginx 容器 403

  console.log(
    `${PREFIX} 完成：成功 ${done}，失败 ${failed}${noReadme ? `，无 README ${noReadme}` : ''}` +
      `，数据文件已注入摘要 ${injected} 条、README ${readmeCount} 条（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );
  if (failed > 0 && done === 0 && summarizable.length > 0) process.exit(1);
}

/** README 只放在按榜轮换的抓取缓存里；每次摘要任务都重新注入当前静态 feed */
function applyReadmes(feed, cache, currentIds) {
  let injected = 0;
  for (const f of feed.feeds ?? []) {
    for (const it of f.items ?? []) {
      const id = String(it.id ?? '');
      const readme = currentIds.has(id) ? cache.get(id) : null;
      if (!readme?.text) continue;
      it.content = displayReadme(readme.text);
      injected++;
    }
  }
  return injected;
}

main();
