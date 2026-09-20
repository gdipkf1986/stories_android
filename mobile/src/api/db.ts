import * as SQLite from 'expo-sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 本地 SQLite（expo-sqlite，SDK 第一方）—— 收藏/已读隐藏的结构化存储。
 *
 * 为什么从 AsyncStorage 搬过来：收藏是终身档案，JSON blob 每次点赞都要
 * 全量读改写（O(n) 写放大），也没法索引/分页/搜索；hidden 名单同理且无上限。
 *
 * 约定：
 *  - 进程级单例连接 + WAL；PRAGMA user_version 迁移模式（expo 官方推荐写法），
 *    以后改表结构把 SCHEMA_VERSION +1 并在 migrate() 里补一段升级逻辑
 *  - v0 → v1：把旧 AsyncStorage 的三个 JSON key 灌进表里。旧 key **保留不删**，
 *    作为回滚保险（万一要退回旧版 App 数据还在）；确认稳定后的版本再清理
 *  - 反馈事件队列（stories.fb-queue）与 token 等小配置仍留 AsyncStorage，不值得搬
 */

/** 当前 schema 版本 */
const SCHEMA_VERSION = 1;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** 单例连接；open/迁移失败时清掉缓存，下次调用自动重试 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openAndMigrate().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('stories.db');
  await db.execAsync('PRAGMA journal_mode = WAL');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((row?.user_version ?? 0) < SCHEMA_VERSION) {
    await migrate(db);
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS liked_items (
      item_id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '',
      url TEXT,
      cover TEXT,
      feed TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      metrics_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT 0,
      liked_at INTEGER NOT NULL,
      synced_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_liked_items_liked_at ON liked_items (liked_at DESC);
    CREATE TABLE IF NOT EXISTS hidden_items (
      item_id TEXT PRIMARY KEY NOT NULL,
      verdict TEXT,
      hidden_at INTEGER NOT NULL
    );
  `);
  await importLegacyV0(db);
}

/**
 * v0（AsyncStorage JSON）→ v1 灌入。legacy key 灌完不删（回滚保险）。
 * 单事务批量插入（首启一次性几千行，事务里快一个量级）；
 * 每个 key 独立 try/catch，一份坏数据不拖累其他份。
 */
async function importLegacyV0(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withExclusiveTransactionAsync(async (tx) => {
    // 1) 收藏快照：stories.likes
    try {
      const parsed: unknown = JSON.parse((await AsyncStorage.getItem('stories.likes')) ?? '[]');
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          const like = parseLegacyLike(raw);
          if (!like) continue;
          await tx.runAsync(
            `INSERT OR REPLACE INTO liked_items
               (item_id, source, author, title, excerpt, url, cover, feed,
                tags_json, metrics_json, created_at, liked_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            like.id,
            like.source,
            like.author,
            like.title,
            like.excerpt,
            like.url,
            like.cover,
            like.feed,
            like.tagsJson,
            like.metricsJson,
            like.createdAt,
            like.likedAt,
          );
        }
      }
    } catch {
      // 坏数据不阻塞建库
    }

    // 2) 裁决状态：stories.fb-state（itemId → like/dislike）
    try {
      const parsed: unknown = JSON.parse((await AsyncStorage.getItem('stories.fb-state')) ?? '{}');
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [itemId, verdict] of Object.entries(parsed as Record<string, unknown>)) {
          if (verdict !== 'like' && verdict !== 'dislike') continue;
          await tx.runAsync(
            `INSERT INTO hidden_items (item_id, verdict, hidden_at) VALUES (?, ?, ?)
             ON CONFLICT(item_id) DO UPDATE SET verdict = excluded.verdict`,
            itemId,
            verdict,
            Date.now(),
          );
        }
      }
    } catch {
      // 同上
    }

    // 3) 已读隐藏名单：stories.hidden-items（verdict 未知的只隐藏不裁决）
    try {
      const parsed: unknown = JSON.parse((await AsyncStorage.getItem('stories.hidden-items')) ?? '[]');
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          if (typeof raw !== 'string' || raw.length === 0) continue;
          await tx.runAsync(
            'INSERT OR IGNORE INTO hidden_items (item_id, verdict, hidden_at) VALUES (?, NULL, ?)',
            raw,
            Date.now(),
          );
        }
      }
    } catch {
      // 同上
    }
  });
}

/** 宽松校验旧收藏快照；关键字段缺一个就放弃这条（和旧代码的读取过滤对齐） */
function parseLegacyLike(value: unknown):
  | {
      id: string;
      source: string;
      author: string;
      title: string;
      excerpt: string;
      url: string | null;
      cover: string | null;
      feed: string | null;
      tagsJson: string;
      metricsJson: string;
      createdAt: number;
      likedAt: number;
    }
  | null {
  if (value === null || typeof value !== 'object') return null;
  const it = value as Record<string, unknown>;
  if (typeof it.id !== 'string' || typeof it.title !== 'string' || typeof it.likedAt !== 'number') {
    return null;
  }
  return {
    id: it.id,
    source: typeof it.source === 'string' ? it.source : 'unknown',
    author: typeof it.author === 'string' ? it.author : '',
    title: it.title,
    excerpt: typeof it.excerpt === 'string' ? it.excerpt : '',
    url: typeof it.url === 'string' ? it.url : null,
    cover: typeof it.cover === 'string' ? it.cover : null,
    feed: typeof it.feed === 'string' ? it.feed : null,
    tagsJson: JSON.stringify(Array.isArray(it.tags) ? it.tags.filter((t) => typeof t === 'string') : []),
    metricsJson: JSON.stringify(Array.isArray(it.metrics) ? it.metrics : []),
    createdAt: typeof it.createdAt === 'number' ? it.createdAt : 0,
    likedAt: it.likedAt,
  };
}
