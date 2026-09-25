import { getDb } from './db';
import { API_BASE } from './config';
import { getToken } from './auth';
import type { Metric, SourceId, TimelineItem } from '../types';

/**
 * 「我喜欢」收藏夹 —— 存储在本地 SQLite（api/db.ts），服务端备份同步见 likes-sync.ts。
 *
 *  - 点「♡ 喜欢」的那一刻把整条快照（标题/作者/链接/封面/标签/指标…）写进 liked_items 表，
 *    而不是只存 itemId 事后回查——服务端时间线 JSON 只留最近几天、事件文件轮转只留 2 片，
 *    旧条目过后无处可查；快照保证收藏条目永远可读、原文链接永远打得开。
 *  - 不设条数上限、不做任何清理——「永不过期」。
 *  - 列表按点喜欢的时间倒序（liked_at 索引）；同一条重复点喜欢视为重新喜欢（置顶 + 重新上传）。
 *  - 尽力而为：写失败不阻塞 UI（like 事件照常补发），读失败返回空列表。
 *
 * ⚠️ 服务端契约：POST/GET /api/likes 的行结构 = LikeSyncRow（deploy/api.mjs +
 * scraper/like-store.mjs），改动字段必须两边同步（见根 AGENTS.md 镜像规则）。
 */

/** 收藏条目快照：TimelineItem 里值得长期保留的字段 + likedAt */
export interface LikedItem {
  id: string;
  source: SourceId;
  author: string;
  title: string;
  excerpt: string;
  tags: string[];
  metrics: Metric[];
  /** 原文链接（收藏时快照，可能没有） */
  url?: string;
  /** 封面图（B站视频等，可能没有） */
  cover?: string;
  /** 源内子板块（zhihu:recommend 等，可能没有） */
  feed?: string;
  /** 条目发布时间（原样保留，展示用） */
  createdAt: number;
  /** 点喜欢的时间（毫秒）：排序与展示都以它为准 */
  likedAt: number;
}

/**
 * 收藏同步的线上行结构（/api/likes 的 likes[] 元素，camelCase）。
 * url/cover/feed 服务端可能回 null；metrics 不上传（展示用，且会过期失效）。
 */
export interface LikeSyncRow {
  itemId: string;
  source: string;
  author: string;
  title: string;
  excerpt: string;
  url: string | null;
  cover: string | null;
  feed: string | null;
  tags: string[];
  createdAt: number;
  likedAt: number;
}

/** 读收藏列表（按喜欢时间倒序）；库打不开一律按空列表处理，绝不让收藏屏崩掉 */
export async function loadLikedItems(): Promise<LikedItem[]> {
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<LikedRow>(
      `SELECT item_id, source, author, title, excerpt, url, cover, feed,
              tags_json, metrics_json, created_at, liked_at
       FROM liked_items
       ORDER BY liked_at DESC`,
    );
    return rows.map(rowToLikedItem);
  } catch {
    return [];
  }
}

/** 收藏一条（点「♡ 喜欢」按钮时调用）：按 id 去重，重复收藏按最新时间置顶并标记待上传 */
export async function saveLikedItem(
  item: TimelineItem,
  likedAt: number = Date.now(),
): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO liked_items
         (item_id, source, author, title, excerpt, url, cover, feed,
          tags_json, metrics_json, created_at, liked_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(item_id) DO UPDATE SET
         source = excluded.source, author = excluded.author, title = excluded.title,
         excerpt = excluded.excerpt, url = excluded.url, cover = excluded.cover,
         feed = excluded.feed, tags_json = excluded.tags_json,
         metrics_json = excluded.metrics_json, created_at = excluded.created_at,
         liked_at = excluded.liked_at, synced_at = NULL`,
      item.id,
      item.source,
      item.author,
      item.title,
      item.excerpt,
      item.url ?? null,
      item.cover ?? null,
      item.feed ?? null,
      JSON.stringify(item.tags),
      JSON.stringify(item.metrics),
      item.createdAt,
      likedAt,
    );
  } catch {
    // 尽力而为：存储失败不影响主流程
  }
}

/** 删除一条收藏：先删服务端备份，成功后再删本地；服务端失败时保留原状，避免下次同步复活。 */
export async function deleteLikedItem(itemId: string): Promise<void> {
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/likes/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) throw new Error('删除失败');

  const db = await getDb();
  await db.runAsync('DELETE FROM liked_items WHERE item_id = ?', itemId);
}

/** 待上传的收藏（synced_at IS NULL = 新收藏/重新喜欢过，还没推到服务端） */
export async function takeUnsyncedLikes(limit = 50): Promise<LikeSyncRow[]> {
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<LikedRow>(
      `SELECT item_id, source, author, title, excerpt, url, cover, feed,
              tags_json, created_at, liked_at
       FROM liked_items WHERE synced_at IS NULL
       ORDER BY liked_at DESC LIMIT ?`,
      limit,
    );
    return rows.map(rowToSyncRow);
  } catch {
    return [];
  }
}

/** 上传成功后打同步戳。带 liked_at 条件：上传期间又点了喜欢的新版本不会被误标 */
export async function markLikesSynced(
  rows: { itemId: string; likedAt: number }[],
  syncedAt: number,
): Promise<void> {
  try {
    const db = await getDb();
    for (const row of rows) {
      await db.runAsync(
        'UPDATE liked_items SET synced_at = ? WHERE item_id = ? AND liked_at = ?',
        syncedAt,
        row.itemId,
        row.likedAt,
      );
    }
  } catch {
    // 打戳失败 = 下次多推一遍，服务端按 itemId 去重，无害
  }
}

/**
 * 合并服务端下行收藏：只接受严格更新的版本（excluded.liked_at > 本地）。
 * 自己刚推上去又拉回来的（likedAt 相等）不会回写覆盖本地快照。
 * 返回实际合并条数。
 */
export async function mergeRemoteLikes(rows: LikeSyncRow[], syncedAt: number): Promise<number> {
  let merged = 0;
  try {
    const db = await getDb();
    for (const row of rows) {
      if (!isMergeable(row)) continue;
      const result = await db.runAsync(
        `INSERT INTO liked_items
           (item_id, source, author, title, excerpt, url, cover, feed,
            tags_json, metrics_json, created_at, liked_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           source = excluded.source, author = excluded.author, title = excluded.title,
           excerpt = excluded.excerpt, url = excluded.url, cover = excluded.cover,
           feed = excluded.feed, tags_json = excluded.tags_json,
           created_at = excluded.created_at, liked_at = excluded.liked_at,
           synced_at = excluded.synced_at
         WHERE excluded.liked_at > liked_items.liked_at`,
        row.itemId,
        row.source,
        row.author,
        row.title,
        row.excerpt,
        row.url,
        row.cover,
        row.feed,
        JSON.stringify(row.tags),
        row.createdAt,
        row.likedAt,
        syncedAt,
      );
      merged += result.changes;
    }
  } catch {
    // 合并失败下次再拉
  }
  return merged;
}

/** 服务端下行行的最低要求：itemId/title/likedAt 在，tags 是数组 */
export function isMergeable(row: unknown): row is LikeSyncRow {
  if (row === null || typeof row !== 'object') return false;
  const it = row as Partial<LikeSyncRow>;
  return (
    typeof it.itemId === 'string' &&
    typeof it.title === 'string' &&
    typeof it.likedAt === 'number' &&
    Array.isArray(it.tags)
  );
}

// ---------- 内部：行映射 ----------

interface LikedRow {
  item_id: string;
  source: string;
  author: string;
  title: string;
  excerpt: string;
  url: string | null;
  cover: string | null;
  feed: string | null;
  tags_json: string;
  metrics_json?: string;
  created_at: number;
  liked_at: number;
}

function rowToLikedItem(row: LikedRow): LikedItem {
  return {
    id: row.item_id,
    source: row.source as SourceId,
    author: row.author,
    title: row.title,
    excerpt: row.excerpt,
    tags: parseJsonArray(row.tags_json),
    metrics: parseJsonArray<Metric>(row.metrics_json ?? '[]'),
    ...(row.url ? { url: row.url } : {}),
    ...(row.cover ? { cover: row.cover } : {}),
    ...(row.feed ? { feed: row.feed } : {}),
    createdAt: row.created_at,
    likedAt: row.liked_at,
  };
}

function rowToSyncRow(row: LikedRow): LikeSyncRow {
  return {
    itemId: row.item_id,
    source: row.source,
    author: row.author,
    title: row.title,
    excerpt: row.excerpt,
    url: row.url,
    cover: row.cover,
    feed: row.feed,
    tags: parseJsonArray(row.tags_json),
    createdAt: row.created_at,
    likedAt: row.liked_at,
  };
}

function parseJsonArray<T = unknown>(text: string): T[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
