#!/usr/bin/env node
/**
 * 多源条目 AI 自动打标（知乎 / B站）：
 * 扫描 public/data/<source>-feed.json，找出还没有标签的条目，调智谱 API
 * 生成 2~4 个分类标签，存入 scraper/storage/<source>-tags.json，并合并回
 * 前端数据文件。已打过标的条目直接跳过，因此可以反复运行（幂等），
 * 通常只对每次新抓取的增量条目产生 API 调用。
 *
 * 用法:
 *   npm run tag:zhihu               # 知乎全量扫描打标（默认源）
 *   npm run tag:bilibili            # B站全量扫描打标
 *   TAG_LIMIT=3 npm run tag:bilibili  # 本次最多处理 N 条（试跑用）
 *
 * 环境变量:
 *   ZHIPU_API_KEY    缺省时从 ~/.config/opencode/opencode.jsonc 读取
 *   ZHIPU_MODEL      默认 glm-4-flash（智谱免费模型，成本为零）
 *   ZHIPU_BASE_URL   默认 https://open.bigmodel.cn/api/paas/v4
 *   TAG_CONCURRENCY  并发数，默认 3
 */
import { readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { applyTags, loadTagStore, saveTagStore } from './tag-store.mjs';
import { BASE_URL, MODEL, chatComplete, resolveApiKey } from './zhipu.mjs';

/** 支持的源 → 各自的前端数据文件（public/data/ 下） */
const SOURCE_FEEDS = {
  zhihu: 'zhihu-feed.json',
  bilibili: 'bilibili-feed.json',
  github: 'github-feed.json',
  weibo: 'weibo-feed.json',
};

const SOURCE_ARGV = process.argv.indexOf('--source');
const SOURCE = (SOURCE_ARGV >= 0 ? process.argv[SOURCE_ARGV + 1] : 'zhihu')?.toLowerCase() ?? 'zhihu';
if (!SOURCE_FEEDS[SOURCE]) {
  console.error(`[tag] 未知源: ${SOURCE}（可选: ${Object.keys(SOURCE_FEEDS).join(' / ')}）`);
  process.exit(1);
}
const PREFIX = `[tag:${SOURCE}]`;
const FEED_FILE = path.resolve(import.meta.dirname, '..', 'public', 'data', SOURCE_FEEDS[SOURCE]);

const CONCURRENCY = Math.max(1, Number(process.env.TAG_CONCURRENCY ?? 3) || 3);
const LIMIT = Math.max(0, Number(process.env.TAG_LIMIT ?? 0) || 0); // 0 = 不限制

const SYSTEM_PROMPT =
  '你是内容分类标签助手。根据给定的标题和摘要，输出 2~4 个简体中文标签，' +
  '用于个人时间线的内容分类（如：人工智能、网络安全、游戏、数码产品、编程、职场、历史、体育…）。' +
  '要求：每个标签 2~6 个字；贴住内容主题，不要太宽泛（不要用"内容""分享"这类词）；' +
  '只输出一个 JSON 字符串数组，例如 ["人工智能","网络安全"]，不要输出任何其他文字或解释。';

/** 从模型返回的文本里防御性地解析出标签数组 */
function parseTags(text) {
  const m = text.match(/\[[\s\S]*?\]/); // 兼容模型偶尔包一层 ```json
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    const tags = [...new Set(
      arr
        .filter((t) => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && t.length <= 12),
    )].slice(0, 4);
    return tags.length > 0 ? tags : null;
  } catch {
    return null;
  }
}

/** 调智谱 API 生成标签（重试/超时在 zhipu.chatComplete 内部处理） */
async function generateTags(item, apiKey) {
  const excerpt = item.excerpt ? item.excerpt.slice(0, 400) : '（无摘要，仅根据标题判断）';
  const content = await chatComplete({
    apiKey,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `标题：${item.title}\n摘要：${excerpt}` },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });
  const tags = parseTags(content);
  if (!tags) throw new Error(`无法解析返回：${content.slice(0, 80)}`);
  return tags;
}

/** 简单并发池：最多 limit 个任务同时跑 */
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
    console.error(`${PREFIX} 读取 ${FEED_FILE} 失败：${e.message}（先跑 npm run scrape / sync:${SOURCE}）`);
    process.exit(1);
  }

  const store = await loadTagStore(SOURCE);

  // 按 id 去重收集未打标条目（同一条内容可能出现在多个流里）
  const untagged = [];
  const seen = new Set();
  let total = 0;
  for (const f of feed.feeds ?? []) {
    for (const it of f.items ?? []) {
      total++;
      const id = String(it.id ?? '');
      if (!id || seen.has(id) || store.has(id)) continue;
      seen.add(id);
      const title = typeof it.title === 'string' ? it.title.trim() : '';
      if (!title) continue; // 没标题没法分类
      untagged.push({ id, title, excerpt: typeof it.excerpt === 'string' ? it.excerpt : '', type: it.type });
    }
  }

  const batch = LIMIT > 0 ? untagged.slice(0, LIMIT) : untagged;
  console.log(
    `${PREFIX} 共 ${total} 条，标签库已有 ${store.size} 条，待打标 ${untagged.length} 条` +
      (LIMIT > 0 ? `（本次限额 ${batch.length} 条）` : '') +
      `，模型 ${MODEL}`,
  );

  let done = 0;
  let failed = 0;
  await runPool(batch, CONCURRENCY, async (item) => {
    try {
      const tags = await generateTags(item, apiKey);
      store.set(item.id, tags);
      done++;
      console.log(`  ✓ [${done}/${batch.length}] ${item.title.slice(0, 30)}… → ${tags.join(' / ')}`);
    } catch (e) {
      failed++;
      console.warn(`  ✗ ${item.title.slice(0, 30)}… → ${e.message}（下次扫描会重试）`);
    }
    if ((done + failed) % 10 === 0) await saveTagStore(store, { model: MODEL, source: SOURCE }); // 周期落盘，中断不丢进度
  });

  if (batch.length > 0) await saveTagStore(store, { model: MODEL, source: SOURCE });

  // 合并回前端数据文件（无论本次有没有新标签，都保证文件与标签库同步）
  const injected = applyTags(feed, store);
  await writeFile(FEED_FILE, `${JSON.stringify(feed, null, 2)}\n`, 'utf8');
  await chmod(FEED_FILE, 0o644); // NAS 权限保护层：防止 nginx 容器 403

  console.log(
    `${PREFIX} 完成：成功 ${done}，失败 ${failed}，数据文件已注入标签 ${injected} 条` +
      `（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );
  if (failed > 0 && done === 0) process.exit(1); // 全军覆没才报失败，个别失败下次扫描重试
}

main();
