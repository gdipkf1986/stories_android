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
import path from 'node:path';

const STORAGE_DIR = path.resolve(import.meta.dirname, 'storage');

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
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  await chmod(file, 0o644); // NAS 权限保护层
}

/** 把摘要库合并进 feed 数据：给每条匹配的 item 注入 summary 字段。返回注入条数。 */
export function applySummaries(feed, store) {
  let injected = 0;
  for (const f of feed.feeds ?? []) {
    for (const it of f.items ?? []) {
      const entry = store.get(String(it.id ?? ''));
      if (entry) {
        it.summary = entry.summary;
        injected++;
      }
    }
  }
  return injected;
}
