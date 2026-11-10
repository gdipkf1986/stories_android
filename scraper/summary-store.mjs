/**
 * 条目 LLM 摘要的持久化存储与合并工具（github-summarizer / sync-github 共用，
 * 结构照 tag-store.mjs：独立存储 + sync 时合并注入）。
 *
 * 为什么独立存储（scraper/storage/<source>-summaries.json，已 gitignore）：
 * 抓取产物每次整份覆盖，摘要直接写进 feed JSON 会被下一次同步冲掉；
 * 按条目原始 id（owner/name）索引，重新抓取、换机器同步都不丢。
 * LLM 总结有成本，摘要库还兼任「已总结过」的幂等标记。
 */
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// 存储目录可用环境变量覆盖：deploy 容器把 scraper/storage 挂在 /app/storage，
// api.mjs 引入本模块时靠 SCRAPER_STORAGE_DIR=/app/storage 对齐同一份文件
const STORAGE_DIR = process.env.SCRAPER_STORAGE_DIR ?? path.resolve(import.meta.dirname, 'storage');

/** 某个源的摘要库文件路径 */
export function summariesFileFor(source = 'github') {
  return path.join(STORAGE_DIR, `${source}-summaries.json`);
}

/** 读取摘要库，返回 Map<条目原始id, { summary, readme, lang, summarized_at, model }>；损坏视为空库 */
export async function loadSummaryStore(source = 'github') {
  const file = summariesFileFor(source);
  if (!existsSync(file)) return new Map();
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const map = new Map();
    for (const [id, entry] of Object.entries(raw.summaries ?? {})) {
      if (entry && typeof entry === 'object' && typeof entry.summary === 'string' && entry.summary.trim()) {
        map.set(id, entry);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** 原子写入摘要库（先写 tmp 再 rename，中途崩溃不会留下半截 JSON） */
export async function saveSummaryStore(store, { model = null, source = 'github' } = {}) {
  const file = summariesFileFor(source);
  await mkdir(path.dirname(file), { recursive: true });
  const data = {
    version: 1,
    source,
    updated_at: new Date().toISOString(),
    model,
    summaries: Object.fromEntries(store),
  };
  // tmp 文件名按调用唯一：同进程并发保存（批处理并发池 / API 并发翻译）共用一个
  // tmp 名时，A 写完还没 rename 就被 B rename 走 → ENOENT 崩进程（2026-09-22 踩过两次）
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  await chmod(file, 0o644); // NAS 权限保护层
}

/** 把摘要库合并进 feed 数据：给每条匹配的 item 注入 summary（及可选的 title_zh/content_zh）字段。返回注入条数。 */
export function applySummaries(feed, store) {
  let injected = 0;
  for (const f of feed.feeds ?? []) {
    for (const it of f.items ?? []) {
      const entry = store.get(String(it.id ?? ''));
      if (entry) {
        it.summary = entry.summary;
        if (typeof entry.title_zh === 'string' && entry.title_zh) it.title_zh = entry.title_zh;
        if (typeof entry.content_zh === 'string' && entry.content_zh) it.content_zh = entry.content_zh;
        injected++;
      }
    }
  }
  return injected;
}

/** 从长期档案恢复排序器可能仍会推荐的过榜条目，供按需翻译使用 */
export async function restoreSummaryFromArchive(store, source, rawId) {
  const dbFile = process.env.STORIES_DB_FILE ?? path.join(STORAGE_DIR, 'stories.db');
  if (!existsSync(dbFile)) return false;

  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const item = db.prepare(
      'SELECT item_id, title, url, last_seen_at FROM items WHERE item_id = ?',
    ).get(`${source}:${rawId}`);
    if (!item) return false;

    const summary = db.prepare(`
      SELECT title, summary, model
      FROM item_summaries
      WHERE item_id = ? AND summary_kind = 'feed'
    `).get(item.item_id);
    if (!summary && source !== 'github') return false;

    const original = db.prepare(`
      SELECT content_text, language
      FROM item_content
      WHERE item_id = ? AND content_kind = 'original'
    `).get(item.item_id);
    if (!summary && !original?.content_text) return false;

    const entry = {
      summary: summary?.summary ?? item.title ?? rawId,
      summarized_at: new Date(Number(item.last_seen_at) || Date.now()).toISOString(),
    };
    if (summary?.title) entry.title_zh = summary.title;
    if (item.url) entry.url = item.url;
    if (summary?.model) entry.model = summary.model;
    if (original?.content_text) {
      entry.content = original.content_text;
      if (original.language) entry.lang = original.language;
    }

    store.set(String(rawId), entry);
    await saveSummaryStore(store, { model: summary?.model ?? null, source });
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
