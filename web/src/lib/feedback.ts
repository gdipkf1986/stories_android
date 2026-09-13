/**
 * 行为埋点与反馈上报。
 *
 * 设计（对齐后端 event-store.mjs 的约定）：
 *  - 事件先进 localStorage 队列，凑满 BATCH_SIZE 或页面隐藏时经
 *    navigator.sendBeacon 批量上报（失败留队列下次再试，eid 去重防双计）
 *  - 事件只追加不阻塞 UI：上报是 best-effort，失败静默
 *  - kind 与权重是通用货币，与数据源无关——任何源的卡片都发同一套事件
 */

export type FeedbackKind = 'click' | 'read' | 'expand' | 'like' | 'dislike';

/** 单条待上报事件（字段与 deploy/api.mjs 的 normalizeEvent 对齐） */
interface FeedbackEvent {
  eid: string;
  kind: FeedbackKind;
  itemId: string;
  source: string;
  tags: string[];
  author: string;
  title: string;
  dwellMs?: number;
}

interface ItemRef {
  id: string;
  source: string;
  tags: string[];
  author: string;
  title: string;
}

const QUEUE_KEY = 'stories:fb-queue';
const STATE_KEY = 'stories:fb-state'; // itemId → 'like' | 'dislike'
const BATCH_SIZE = 10;
const ENDPOINT = '/api/events';

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadQueue(): FeedbackEvent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.eid === 'string') : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: FeedbackEvent[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-200))); // 上限防膨胀
  } catch {
    /* 存储满等异常：放弃持久化，本次会话内仍可上报 */
  }
}

/** 卡片反馈的本地状态（跨刷新持久，驱动按钮高亮） */
export type FeedbackState = 'like' | 'dislike' | undefined;

export function feedbackStateOf(itemId: string): FeedbackState {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}');
    return raw[itemId] ?? undefined;
  } catch {
    return undefined;
  }
}

function setFeedbackState(itemId: string, state: Exclude<FeedbackState, undefined>): void {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}');
    raw[itemId] = state;
    localStorage.setItem(STATE_KEY, JSON.stringify(raw));
  } catch {
    /* 忽略 */
  }
}

function enqueue(event: FeedbackEvent): void {
  const queue = loadQueue();
  queue.push(event);
  saveQueue(queue);
  if (queue.length >= BATCH_SIZE) void flush();
}

/** 上报队列：优先 sendBeacon（页面隐藏也可靠），退化为 fetch keepalive */
export async function flush(): Promise<void> {
  const queue = loadQueue();
  if (queue.length === 0) return;
  const body = JSON.stringify({ events: queue });
  const blob = new Blob([body], { type: 'application/json' });
  if (navigator.sendBeacon?.(ENDPOINT, blob)) {
    saveQueue([]);
    return;
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    if (res.ok) saveQueue([]);
  } catch {
    /* 留在队列，下次再试 */
  }
}

function track(kind: FeedbackKind, item: ItemRef, extra?: Partial<FeedbackEvent>): void {
  enqueue({
    eid: uuid(),
    kind,
    itemId: item.id,
    source: item.source,
    tags: item.tags.slice(0, 8),
    author: item.author.slice(0, 60),
    title: item.title.slice(0, 120),
    ...extra,
  });
}

// ── 卡片级动作 ────────────────────────────────────────────────

/** 点开标题（外部跳转前发） */
export function trackClick(item: ItemRef): void {
  track('click', item);
}

/** 显式喜欢（幂等，重复点击不重复计） */
export function likeItem(item: ItemRef): FeedbackState {
  if (feedbackStateOf(item.id) === 'like') return 'like';
  setFeedbackState(item.id, 'like');
  track('like', item);
  return 'like';
}

/** 不感兴趣：记负反馈并返回 true；由调用方决定是否当场隐藏卡片 */
export function dislikeItem(item: ItemRef): FeedbackState {
  setFeedbackState(item.id, 'dislike');
  track('dislike', item);
  return 'dislike';
}

// ── 生命周期 ─────────────────────────────────────────────────

let installed = false;

/** 在 App 挂载时调用一次：安装页面隐藏兜底上报 + 定时冲刷 */
export function initFeedback(): void {
  if (installed) return;
  installed = true;
  const onHide = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  window.setInterval(() => void flush(), 30_000);
}
