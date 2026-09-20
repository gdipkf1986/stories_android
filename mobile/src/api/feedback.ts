import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from './config';
import { getToken } from './auth';
import { getDb } from './db';
import type { TimelineItem } from '../types';

/**
 * 行为上报 + 已读隐藏（与 stories web 端 src/lib/feedback.ts 同一套事件约定）：
 *  - 点「喜欢」或点开「查看原文」：入队一条 like 事件（最强正向信号），批量补发 POST /api/events
 *  - 点「不感兴趣」：入队一条 dislike 事件（强负向，服务端画像记避雷）
 *  - 以上操作都会把条目记入本地隐藏名单，下次加载/刷新后不再出现
 *    （本次会话内的展示由 UI 决定：点开的卡片就地折叠，喜欢/不感兴趣立即移除）
 *
 * 与后端 scraper/event-store.mjs 的约定：
 *  - 每条事件带客户端生成的 eid，服务端按 eid 去重，重试/补发不会双计
 *  - nginx 层做 JWT 认证，这里和其他 API 一样自动附加 Bearer
 *  - 上报是尽力而为：网络失败事件留在队列里等下次补发，绝不阻塞 UI
 *
 * ⚠️ 与 web 端的实现分歧（镜像副本仅事件协议部分保持一致）：
 *  - 裁决状态/隐藏名单存本地 SQLite（api/db.ts 的 hidden_items 表，无上限），
 *    不再用 AsyncStorage 的 stories.fb-state / stories.hidden-items
 *    （旧 key 由 db.ts 迁移时灌入并保留，回滚保险）
 *  - 事件队列 stories.fb-queue 体量小且有上限，仍留 AsyncStorage
 */

const QUEUE_KEY = 'stories.fb-queue';

const FLUSH_THRESHOLD = 10; // 攒够一批立即补发（与 web 端一致）
const FLUSH_DELAY_MS = 3_000; // 不满一批时延迟去抖补发
const QUEUE_CAP = 200; // 队列上限，超出丢最旧的

/** 与后端 normalizeEvent 对齐的事件结构（kind 白名单校验在服务端） */
interface FeedbackEvent {
  eid: string;
  kind: 'like' | 'click' | 'read' | 'expand' | 'dislike';
  itemId: string;
  source: string;
  tags: string[];
  author: string;
  title: string;
}

function newEventId(): string {
  // Hermes 不保证有 crypto.randomUUID，按 web 端同款降级方案拼一个
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readQueue(): Promise<FeedbackEvent[]> {
  try {
    const parsed: unknown = JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is FeedbackEvent => Boolean(e) && typeof e === 'object' && typeof (e as FeedbackEvent).eid === 'string',
    );
  } catch {
    return [];
  }
}

async function writeQueue(events: FeedbackEvent[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(events.slice(-QUEUE_CAP)));
  } catch {
    // 存储失败不阻塞交互，大不了这次事件不补发
  }
}

/** 把事件塞进队列；攒满一批立即补发，否则起一个去抖定时器 */
async function enqueue(event: FeedbackEvent): Promise<void> {
  const queue = await readQueue();
  queue.push(event);
  await writeQueue(queue);
  if (queue.length >= FLUSH_THRESHOLD) {
    void flushFeedback();
  } else {
    scheduleFlush();
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushFeedback();
  }, FLUSH_DELAY_MS);
}

/** 把队列里的事件批量补发到 /api/events；成功才清队列，失败留着下次再试 */
export async function flushFeedback(): Promise<void> {
  const queue = await readQueue();
  if (queue.length === 0) return;
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const token = await getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${API_BASE}/api/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ events: queue.slice(-50) }),
    });
    if (res.ok) {
      const sent = new Set(queue.slice(-50).map((e) => e.eid));
      const rest = (await readQueue()).filter((e) => !sent.has(e.eid));
      await writeQueue(rest);
    }
  } catch {
    // 网络失败：事件留在队列，等下一次触发
  }
}

/** 已读隐藏名单（SQLite，无上限——读过的内容不该因 2000 上限重新冒出来） */
export async function loadHiddenItemIds(): Promise<Set<string>> {
  try {
    const db = await getDb();
    const rows = await db.getAllAsync<{ item_id: string }>('SELECT item_id FROM hidden_items');
    return new Set(rows.map((r) => r.item_id));
  } catch {
    return new Set();
  }
}

/** 记录某条目的当前裁决（like/dislike 覆盖写）；返回写入前的旧裁决，供去重判断 */
async function recordVerdict(
  itemId: string,
  verdict: 'like' | 'dislike',
): Promise<'like' | 'dislike' | null> {
  const db = await getDb();
  const prev = await db.getFirstAsync<{ verdict: string | null }>(
    'SELECT verdict FROM hidden_items WHERE item_id = ?',
    itemId,
  );
  const previous = prev?.verdict === 'like' || prev?.verdict === 'dislike' ? prev.verdict : null;
  await db.runAsync(
    `INSERT INTO hidden_items (item_id, verdict, hidden_at) VALUES (?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET verdict = excluded.verdict, hidden_at = excluded.hidden_at`,
    itemId,
    verdict,
    Date.now(),
  );
  return previous;
}

/** 按条目拼一条标准事件（字段截断与 web 端/服务端 normalizeEvent 对齐） */
function buildEvent(item: TimelineItem, kind: FeedbackEvent['kind']): FeedbackEvent {
  return {
    eid: newEventId(),
    kind,
    itemId: item.id,
    source: item.source,
    tags: item.tags.slice(0, 8),
    author: item.author.slice(0, 60),
    title: item.title.slice(0, 120),
  };
}

/**
 * 点了「喜欢」（手动按钮或点开原文）：从信息流隐藏 + 入队一条 like 事件。
 *  - 首次：入队上报（重复点击不重复上报，与 web 端一致）
 *  - 无论是否首次：都记入隐藏名单（防止状态被清后旧文重新冒出来）
 * 纯本地操作 + 异步补发，不抛错、不阻塞 UI。
 */
export function markItemLiked(item: TimelineItem): void {
  void (async () => {
    try {
      const previous = await recordVerdict(item.id, 'like');
      if (previous === 'like') return;
    } catch {
      // 库失败不挡上报：队列照入（服务端按 eid 去重，多一条无害）
    }
    await enqueue(buildEvent(item, 'like'));
  })();
}

/** 点开「查看原文」等价于点了喜欢，与手动按钮同一条路径 */
export function markItemOpened(item: TimelineItem): void {
  markItemLiked(item);
}

/**
 * 点了「不感兴趣」：从信息流隐藏 + 入队一条 dislike 事件（强负向，
 * 服务端画像会据此记避雷标签）。与 web 端一致：每次点击都上报，不做去重。
 */
export function markItemDisliked(item: TimelineItem): void {
  void (async () => {
    try {
      await recordVerdict(item.id, 'dislike');
    } catch {
      // 同上
    }
    await enqueue(buildEvent(item, 'dislike'));
  })();
}
