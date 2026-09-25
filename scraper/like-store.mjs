/**
 * 「我喜欢」收藏存储：scraper/storage/likes.jsonl（append-only，一行一条）。
 *
 * 与 events.jsonl（行为信号流，喂画像/排序，会轮转）刻意不同，这里是收藏夹本体：
 *  - 不轮转；删除写 tombstone（deletedAt），保留原始收藏供审计和恢复能力
 *  - 同一 itemId 重复追加是常态（重复点赞/多端推送），读取时按 itemId 去重、
 *    likedAt 新者胜，旧行自然作废但保留（审计友好，也不需要 compaction）
 *  - url/cover/excerpt 全量保留：这份是跨设备/重装的备份，必须不靠时间线 JSON
 *    就能独立展示和打开原文（时间线只留最近几天）
 *
 * 请求/返回结构是 APK 端 mobile/src/api/likes.ts + likes-sync.ts 的镜像约定，
 * 改动这里必须同步检查那两处（见根 AGENTS.md 的镜像副本规则）。
 */
import { appendFile, readFile } from 'node:fs/promises';

const ITEM_ID_RE = /^[A-Za-z0-9_:.\-]{1,200}$/; // 与 event-store 的 itemId 同一约定
const TAG_MAX = 24;
const URL_RE = /^https?:\/\//i;

function clipStr(value, max) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function clipUrl(value, max = 2048) {
  const s = String(value ?? '').trim();
  return URL_RE.test(s) ? s.slice(0, max) : null;
}

/** 时间戳：只接受正数，且不允许超过当前时间 1 天（防客户端时钟漂移污染排序） */
function clipTime(value, now) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, now + 86_400_000);
}

/** 校验并规范化一条客户端收藏；不合法返回 null（绝不把脏数据写进收藏层） */
export function normalizeLikeInput(input, { now = Date.now() } = {}) {
  if (input === null || typeof input !== 'object') return null;
  const itemId = String(input.itemId ?? '');
  if (!ITEM_ID_RE.test(itemId)) return null;
  const title = clipStr(input.title, 200);
  if (!title) return null; // 没标题的收藏没法展示，直接拒收
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((t) => clipStr(t, TAG_MAX)).filter(Boolean))].slice(0, 8)
    : [];
  return {
    itemId,
    source: clipStr(input.source, 24) || 'unknown',
    author: clipStr(input.author, 60),
    title,
    excerpt: clipStr(input.excerpt, 500),
    url: clipUrl(input.url),
    cover: clipUrl(input.cover),
    feed: clipStr(input.feed, 40) || null,
    tags,
    createdAt: clipTime(input.createdAt, now) ?? 0,
    likedAt: clipTime(input.likedAt, now) ?? now,
    t: now, // 服务端收到时间（审计用，排序/合并只认客户端的 likedAt）
  };
}

/** 追加一批收藏（一行一条 JSON）；返回实际写入行数 */
export async function appendLikes(likes, { likesFile }) {
  if (likes.length === 0) return 0;
  const lines = likes.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await appendFile(likesFile, lines, 'utf8');
  return likes.length;
}

/** 追加删除墓碑；返回实际写入数。以后重新喜欢会因收到时间更新而重新可见。 */
export async function appendLikeDeletes(itemIds, { likesFile }) {
  const now = Date.now();
  const ids = [...new Set(itemIds.filter((id) => ITEM_ID_RE.test(String(id ?? ''))))];
  if (ids.length === 0) return 0;
  const lines = ids
    .map((itemId) => JSON.stringify({ itemId, deletedAt: now, t: now }))
    .join('\n') + '\n';
  await appendFile(likesFile, lines, 'utf8');
  return ids.length;
}

/**
 * 全量读取并合并：按 itemId 去重、likedAt 新者胜，按 likedAt 倒序返回。
 * 文件永不轮转所以只有一个分片；行损坏跳过不计（收藏丢一行比崩掉强）。
 */
export async function readAllLikes({ likesFile }) {
  let text = '';
  try {
    text = await readFile(likesFile, 'utf8');
  } catch {
    return []; // 文件不存在是常态（还没收藏过）
  }
  const byId = new Map();
  const deletedAtById = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e === null || typeof e !== 'object' || typeof e.itemId !== 'string') continue;
      if (Number.isFinite(e.deletedAt)) {
        const prevDeletedAt = deletedAtById.get(e.itemId) ?? 0;
        deletedAtById.set(e.itemId, Math.max(prevDeletedAt, e.deletedAt));
        continue;
      }
      const prev = byId.get(e.itemId);
      if (!prev || (e.likedAt ?? 0) >= (prev.likedAt ?? 0)) byId.set(e.itemId, e);
    } catch {
      // 损坏行跳过
    }
  }
  return [...byId.values()]
    .filter((e) => (e.t ?? 0) > (deletedAtById.get(e.itemId) ?? Number.NEGATIVE_INFINITY))
    .sort((a, b) => (b.likedAt ?? 0) - (a.likedAt ?? 0));
}
