/**
 * 行为事件存储：scraper/storage/events.jsonl（append-only，一行一条）。
 *
 * 设计原则（借鉴 OpenBiliClaw 的分层防抖动）：
 *  - 事件层只追加事实，永不改写；画像由 profile-engine 从事件全量重算（幂等）
 *  - 每条事件带客户端生成的 eid，消费侧按 eid 去重，重试/补发不会双计
 *  - 文件过大时轮转（events.1.jsonl ← events.jsonl），引擎按序读所有分片
 *
 * 事件由浏览器端埋点产生（src/lib/feedback.ts），经 /api/events 写入。
 * kind 与权重是"排序管线的通用货币"：与具体数据源无关，
 * 未来接入新数据源时只要前端能发出这些 kind，排序自动生效。
 */
import { appendFile, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const EVENT_KINDS = /** @type {const} */ ({
  click: 0.25, // 点开标题：弱辅助信号
  read: 0.5, // 停留阅读（dwellMs ≥ 30s 时由前端补发）：弱但真实
  expand: 0.1, // 展开摘要等被动交互
  like: 1.5, // 显式喜欢：最强正向
  dislike: -3.0, // 不感兴趣：强负向，同时触发画像层避雷
});

export const READ_MIN_MS = 30_000; // 超过它 click 升级为 read

const EVENT_ID_RE = /^[A-Za-z0-9_:.\-]{1,200}$/;
const TAG_MAX = 24;
/** 校验并规范化一条客户端事件；不合法返回 null（绝不把脏数据写进事件层） */
export function normalizeEvent(input, { now = Date.now() } = {}) {
  if (input === null || typeof input !== 'object') return null;
  const kind = String(input.kind ?? '');
  const weight = EVENT_KINDS[kind];
  if (weight === undefined) return null;
  const itemId = String(input.itemId ?? '');
  if (!EVENT_ID_RE.test(itemId)) return null;
  const tags = Array.isArray(input.tags)
    ? [...new Set(
        input.tags
          .map((t) => String(t ?? '').trim())
          .filter((t) => t.length > 0 && t.length <= TAG_MAX),
      )].slice(0, 8)
    : [];
  const dwellMs = Math.max(0, Math.min(Number(input.dwellMs) || 0, 2 * 3_600_000));
  return {
    eid: EVENT_ID_RE.test(String(input.eid ?? '')) ? String(input.eid) : null,
    t: now, // 服务端时间为准，客户端时间仅作参考不落库
    kind,
    weight,
    itemId,
    source: String(input.source ?? '').slice(0, 24) || 'unknown',
    tags,
    author: String(input.author ?? '').slice(0, 60),
    title: String(input.title ?? '').slice(0, 120),
    ...(dwellMs > 0 ? { dwellMs } : {}),
  };
}

/** 追加一批事件（一行一条 JSON）；返回实际写入行数 */
export async function appendEvents(events, { eventsFile }) {
  if (events.length === 0) return 0;
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await appendFile(eventsFile, lines, 'utf8');
  return events.length;
}

/**
 * 按序读取所有事件分片（旧的轮转分片在前），按 eid 去重。
 * 返回 { events, duplicates, corrupted }。
 */
export async function readAllEvents({ storageDir, eventsFile }) {
  const parts = [path.join(storageDir, 'events.2.jsonl'), path.join(storageDir, 'events.1.jsonl'), eventsFile];
  const seen = new Set();
  const events = [];
  let duplicates = 0;
  let corrupted = 0;
  for (const file of parts) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue; // 分片不存在是常态
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const e = JSON.parse(trimmed);
        if (e.eid) {
          if (seen.has(e.eid)) {
            duplicates++;
            continue;
          }
          seen.add(e.eid);
        }
        events.push(e);
      } catch {
        corrupted++;
      }
    }
  }
  events.sort((a, b) => (a.t ?? 0) - (b.t ?? 0)); // 引擎按时间序重放
  return { events, duplicates, corrupted };
}

/**
 * 轮转：events.jsonl 超过 maxBytes 时左移为 events.1.jsonl（更旧的顺移，最多留 2 份）。
 * 返回是否发生了轮转。
 */
export async function rotateIfNeeded({ storageDir, eventsFile, maxBytes = 5 * 1024 * 1024 }) {
  let size = 0;
  try {
    size = (await stat(eventsFile)).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;
  const two = path.join(storageDir, 'events.2.jsonl');
  const one = path.join(storageDir, 'events.1.jsonl');
  try {
    await rm(two, { force: true });
    await rename(one, two).catch(() => {});
    await rename(eventsFile, one);
    return true;
  } catch {
    return false; // 轮转失败不影响写入（下次再试）
  }
}
