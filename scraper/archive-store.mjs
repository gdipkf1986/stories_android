/**
 * archive-store.mjs — 服务端长期数据档案层（SQLite）。
 *
 * 设计边界：这里是跨源条目的 canonical archive，保存“见过什么、有哪些正文/标签/摘要”；
 * public/data/*.json 仍然是面向 APK 的只读快照导出物，不因引入 SQLite 改变契约。
 * 当前阶段调度器在 enrichment（标签/摘要）完成后导入一次，后续可逐步把生成器改为读写本库。
 *
 * 运行要求：Node 24+ 的 node:sqlite；存储目录在本地 ext4，适合 WAL。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_FILE = resolve(import.meta.dirname, 'storage', 'stories.db');
const SCHEMA_VERSION = 1;

/** 打开并迁移档案库；每个进程持有一个同步连接，WAL 负责读写并发 */
export function openArchive(dbFile = process.env.STORIES_DB_FILE ?? DEFAULT_DB_FILE) {
  const file = resolve(dbFile);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
  migrateArchive(db);
  return db;
}

function migrateArchive(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version >= SCHEMA_VERSION) return;
  if (version > SCHEMA_VERSION) {
    throw new Error(`SQLite schema ${version} 新于当前程序支持的 ${SCHEMA_VERSION}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 跨源 item 主档；raw feed 每轮会被覆盖，这里保留首次见达与最近见达时间
    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      raw_id TEXT NOT NULL,
      feed TEXT,
      title TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      url TEXT,
      author TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(source, raw_id)
    );
    CREATE INDEX IF NOT EXISTS idx_items_source_last_seen ON items(source, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_title ON items(title);

    -- 正文和译文分开存，避免 payload JSON 变成只能整块读取的大字段
    CREATE TABLE IF NOT EXISTS item_content (
      item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
      content_kind TEXT NOT NULL,
      content_text TEXT NOT NULL,
      language TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(item_id, content_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_item_content_kind ON item_content(content_kind);

    CREATE TABLE IF NOT EXISTS item_tags (
      item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(item_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag);

    -- feed 里注入的标题/摘要/全文是 enriched snapshot；model 允许为空（旧数据未知）
    CREATE TABLE IF NOT EXISTS item_summaries (
      item_id TEXT NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
      summary_kind TEXT NOT NULL,
      title TEXT,
      summary TEXT NOT NULL,
      content_text TEXT,
      language TEXT,
      model TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(item_id, summary_kind)
    );
    CREATE INDEX IF NOT EXISTS idx_item_summaries_model ON item_summaries(model);

    CREATE TABLE IF NOT EXISTS import_runs (
      run_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      item_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('running', 'ok', 'failed')),
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_import_runs_source_started ON import_runs(source, started_at DESC);
  `);

  db.prepare(
    "INSERT INTO archive_meta(key, value) VALUES ('schema_version', ?) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(String(SCHEMA_VERSION));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function text(value, max = Infinity) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  return cleaned.slice(0, max);
}

function timestamp(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Unix 秒 → 毫秒；已有毫秒值保持不变
  return n < 100_000_000_000 ? n * 1000 : n;
}

function extractAuthor(item) {
  const author = item.author;
  if (typeof author === 'string') return text(author, 120);
  if (author && typeof author === 'object') return text(author.name, 120);
  return '';
}

/** 导入一个 source 的整份 feed。事务保证所有 item/tags/content/summary 状态一致 */
export function importTimelineFeed(db, { source, raw, capturedAt = Date.now() }) {
  const feeds = Array.isArray(raw?.feeds) ? raw.feeds : [];
  const run = db
    .prepare(
      "INSERT INTO import_runs(source, started_at, status) VALUES (?, ?, 'running')",
    )
    .run(source, capturedAt);
  db.exec('BEGIN IMMEDIATE');
  let itemCount = 0;
  try {
    const seenInThisRun = new Set();
    const insertItem = db.prepare(`
      INSERT INTO items(
        item_id, source, raw_id, feed, title, excerpt, url, author,
        created_at, first_seen_at, last_seen_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        feed = excluded.feed,
        title = CASE WHEN excluded.title != '' THEN excluded.title ELSE items.title END,
        excerpt = CASE WHEN excluded.excerpt != '' THEN excluded.excerpt ELSE items.excerpt END,
        url = COALESCE(excluded.url, items.url),
        author = CASE WHEN excluded.author != '' THEN excluded.author ELSE items.author END,
        created_at = CASE WHEN excluded.created_at > 0 THEN excluded.created_at ELSE items.created_at END,
        last_seen_at = excluded.last_seen_at,
        payload_json = excluded.payload_json
    `);
    const replaceTags = db.prepare(`
      INSERT INTO item_tags(item_id, tag, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(item_id, tag) DO UPDATE SET updated_at = excluded.updated_at
    `);
    const clearTags = db.prepare('DELETE FROM item_tags WHERE item_id = ?');
    const putContent = db.prepare(`
      INSERT INTO item_content(item_id, content_kind, content_text, language, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_id, content_kind) DO UPDATE SET
        content_text = excluded.content_text,
        language = excluded.language,
        updated_at = excluded.updated_at
    `);
    const putSummary = db.prepare(`
      INSERT INTO item_summaries(
        item_id, summary_kind, title, summary, content_text, language, model, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, summary_kind) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        content_text = excluded.content_text,
        language = excluded.language,
        model = excluded.model,
        updated_at = excluded.updated_at
    `);

    for (const feed of feeds) {
      const feedName = text(feed?.source, 60) || null;
      for (const item of Array.isArray(feed?.items) ? feed.items : []) {
        const rawId = text(item?.id, 240);
        if (!rawId || seenInThisRun.has(rawId)) continue;
        seenInThisRun.add(rawId);

        const itemId = `${source}:${rawId}`;
        const title = text(item.title_zh, 400) || text(item.title, 400);
        const excerpt = text(item.summary, 2000) || text(item.excerpt, 2000);
        const url = text(item.url, 2048) || null;
        const createdAt = timestamp(item.created_time, timestamp(raw.scraped_at, capturedAt));
        insertItem.run(
          itemId,
          source,
          rawId,
          feedName,
          title,
          excerpt,
          url,
          extractAuthor(item),
          createdAt,
          capturedAt,
          capturedAt,
          JSON.stringify(item),
        );

        clearTags.run(itemId);
        for (const tag of Array.isArray(item.tags) ? item.tags : []) {
          const cleanTag = text(tag, 80);
          if (cleanTag) replaceTags.run(itemId, cleanTag, capturedAt);
        }

        if (text(item.content, 2_000_000)) {
          putContent.run(itemId, 'original', text(item.content, 2_000_000), text(item.lang, 20) || null, capturedAt);
        }
        if (text(item.content_zh, 2_000_000)) {
          putContent.run(itemId, 'translation_zh', text(item.content_zh, 2_000_000), 'zh', capturedAt);
        }
        const summary = text(item.summary, 20_000);
        if (summary) {
          putSummary.run(
            itemId,
            'feed',
            text(item.title_zh, 400) || null,
            summary,
            text(item.content_zh, 2_000_000) || null,
            'zh',
            text(item.model, 120) || null,
            capturedAt,
          );
        }
        itemCount++;
      }
    }

    db.prepare("UPDATE import_runs SET finished_at = ?, item_count = ?, status = 'ok' WHERE run_id = ?")
      .run(Date.now(), itemCount, run.lastInsertRowid);
    db.exec('COMMIT');
    return { runId: Number(run.lastInsertRowid), itemCount };
  } catch (error) {
    db.exec('ROLLBACK');
    db.prepare("UPDATE import_runs SET finished_at = ?, status = 'failed', error = ? WHERE run_id = ?")
      .run(Date.now(), String(error?.message ?? error), run.lastInsertRowid);
    throw error;
  }
}

/** 档案概况：主档条数、内容量、标签量与最近导入结果 */
export function archiveStats(db) {
  const scalar = (sql) => Number(db.prepare(sql).get().value ?? 0);
  const recent = db
    .prepare(`
      SELECT source, status, item_count, started_at, finished_at, error
      FROM import_runs ORDER BY started_at DESC, run_id DESC LIMIT 10
    `)
    .all();
  return {
    schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version),
    items: scalar('SELECT COUNT(*) AS value FROM items'),
    contents: scalar('SELECT COUNT(*) AS value FROM item_content'),
    tags: scalar('SELECT COUNT(*) AS value FROM item_tags'),
    summaries: scalar('SELECT COUNT(*) AS value FROM item_summaries'),
    bySource: db
      .prepare('SELECT source, COUNT(*) AS count FROM items GROUP BY source ORDER BY source')
      .all(),
    recentRuns: recent,
  };
}
