import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from './config';
import { getToken } from './auth';

/**
 * 画像分析 API：GET /api/profile（分析结果 + 用户裁决状态）、
 * POST /api/verdicts（对某条分析确认/反对）。
 * 与 sources.ts 同款约定：自动附加 Bearer，401 透传给上层触发登录页。
 *
 * 裁决提交走「本地先行」：点击立即写入本地 pending 缓存并乐观更新 UI
 * （submitVerdict 同步返回，不等网络），后台异步把 pending 逐条补发到
 * /api/verdicts；失败留在缓存里等下次重试（fetchProfile 时也会捎带触发）。
 * 服务端数据返回后用 overlayVerdicts 把未同步的裁决盖回去，UI 不会回跳。
 */

export type ProfileVerdict = 'confirmed' | 'rejected';

/** 一条兴趣分析（tag 权重） */
export interface ProfileTagRow {
  tag: string;
  weight: number;
  verdict: ProfileVerdict | null;
  evidenceCount: number;
}

/** 一条避雷分析 */
export interface ProfileDislikeRow {
  tag: string;
  verdict: ProfileVerdict | null;
}

/** 一条作者亲和分析 */
export interface ProfileAuthorRow {
  author: string;
  weight: number;
  verdict: ProfileVerdict | null;
}

export interface ProfileData {
  updatedAt: string | null;
  stats: { totalEvents?: number; byKind?: Record<string, number> };
  topTags: ProfileTagRow[];
  dislikedTags: ProfileDislikeRow[];
  authorAffinity: ProfileAuthorRow[];
  sourceAffinity: Record<string, number>;
  rejectedInterests: string[];
  rejectedAuthors: string[];
  portrait: unknown;
}

export interface ProfileResult {
  data: ProfileData | null;
  /** 401：token 缺失或失效 */
  unauthorized?: boolean;
  error?: string;
}

const EMPTY: ProfileData = {
  updatedAt: null,
  stats: {},
  topTags: [],
  dislikedTags: [],
  authorAffinity: [],
  sourceAffinity: {},
  rejectedInterests: [],
  rejectedAuthors: [],
  portrait: null,
};

/* ---------------- 本地裁决缓存（点击先落这里，后台再补发） ---------------- */

/** 未同步到服务端的裁决：key → 'confirmed' | 'rejected' | 'none'（撤销） */
const PENDING_KEY = 'stories.profile-verdicts.pending';
const FLUSH_RETRY_MS = 30_000; // 补发失败后的重试间隔（下次进屏/下拉也会捎带触发）
const FLUSH_RETRY_CAP_MS = 5 * 60_000; // 连续失败时退避上限
let flushFailures = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

type PendingVerdict = ProfileVerdict | 'none';
type PendingMap = Record<string, PendingVerdict>;

async function loadPending(): Promise<PendingMap> {
  try {
    const parsed: unknown = JSON.parse((await AsyncStorage.getItem(PENDING_KEY)) ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PendingMap = {};
    for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === 'confirmed' || v === 'rejected' || v === 'none') out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function persistPending(pending: PendingMap): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // 存储失败不阻塞 UI：至少本次会话内存里还有（loadPending 的内存外兜底略过）
  }
}

function scheduleFlush(immediate = false): void {
  if (flushTimer) {
    if (!immediate) return;
    clearTimeout(flushTimer); // 新点击要求立即补发，顶掉还在排队的退避重试
    flushTimer = null;
  }
  // immediate：点击后尽快上报；非 immediate：失败后的退避重试
  const wait = immediate ? 0 : Math.min(FLUSH_RETRY_MS * 2 ** flushFailures, FLUSH_RETRY_CAP_MS);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushVerdicts();
  }, wait);
}

/** 把 pending 里的裁决逐条补发到 /api/verdicts；成功即从缓存移除，失败/401 留着下次 */
export async function flushVerdicts(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const pending = await loadPending();
    const keys = Object.keys(pending);
    if (keys.length === 0) {
      flushFailures = 0;
      return;
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let unauthorized = false;
    for (const key of keys) {
      try {
        const res = await fetch(`${API_BASE}/api/verdicts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ key, verdict: pending[key] }),
        });
        if (res.status === 401) {
          unauthorized = true; // token 失效：别再打，等重新登录后由 fetchProfile 再触发
          break;
        }
        if (!res.ok) break; // 服务端异常：整批留到下次
        const cur = await loadPending();
        if (cur[key] === pending[key]) {
          delete cur[key];
          await persistPending(cur);
        }
      } catch {
        break; // 网络失败：留到下次
      }
    }
    const rest = await loadPending();
    if (Object.keys(rest).length === 0) {
      flushFailures = 0;
    } else if (!unauthorized) {
      flushFailures += 1;
      scheduleFlush(); // 没发完（网络失败/服务端异常）：退避后重试
    }
  } finally {
    flushing = false;
  }
}

/** 待同步裁决条数（UI 提示用） */
export async function countPendingVerdicts(): Promise<number> {
  return Object.keys(await loadPending()).length;
}

/**
 * 提交裁决（本地先行，立即返回不等网络）：写入 pending 缓存 + 触发后台补发。
 * UI 应配合 overlayVerdicts 做乐观更新；撤销传 'none'。
 * 返回的 promise 在落盘完成后 resolve（供 UI 刷新「待同步」计数）。
 */
export function submitVerdict(key: string, verdict: PendingVerdict): Promise<void> {
  return (async () => {
    const pending = await loadPending();
    pending[key] = verdict;
    await persistPending(pending);
    scheduleFlush(true);
  })();
}

/**
 * 把裁决覆盖到画像数据上（纯函数，不改入参）：
 *  - confirmed/rejected → 对应行 verdict 置值；rejected 额外把 tag/author 补进已反对名单
 *  - none（撤销）→ verdict 清空 + 从已反对名单移除
 * fetchProfile 用它盖住服务端数据里还没来得及反映的 pending 裁决。
 */
export function overlayVerdicts(
  data: ProfileData,
  overrides: PendingMap,
): ProfileData {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return data;
  const out: ProfileData = {
    ...data,
    topTags: data.topTags.map((r) => ({ ...r })),
    dislikedTags: data.dislikedTags.map((r) => ({ ...r })),
    authorAffinity: data.authorAffinity.map((r) => ({ ...r })),
    rejectedInterests: [...data.rejectedInterests],
    rejectedAuthors: [...data.rejectedAuthors],
  };
  for (const key of keys) {
    const verdict = overrides[key];
    const colon = key.indexOf(':');
    if (colon <= 0 || !verdict) continue;
    const kind = key.slice(0, colon);
    const name = key.slice(colon + 1);
    if (!name) continue;
    if (kind === 'tag') {
      const row = out.topTags.find((r) => r.tag === name);
      if (row) row.verdict = verdict === 'none' ? null : verdict;
      if (verdict === 'rejected' && !out.rejectedInterests.includes(name)) out.rejectedInterests.push(name);
      if (verdict === 'none') out.rejectedInterests = out.rejectedInterests.filter((t) => t !== name);
    } else if (kind === 'dislike') {
      const row = out.dislikedTags.find((r) => r.tag === name);
      if (row) row.verdict = verdict === 'none' ? null : verdict;
    } else if (kind === 'author') {
      const row = out.authorAffinity.find((r) => r.author === name);
      if (row) row.verdict = verdict === 'none' ? null : verdict;
      if (verdict === 'rejected' && !out.rejectedAuthors.includes(name)) out.rejectedAuthors.push(name);
      if (verdict === 'none') out.rejectedAuthors = out.rejectedAuthors.filter((a) => a !== name);
    }
  }
  return out;
}

async function request<T>(path: string, init?: RequestInit): Promise<{
  status: number;
  body: T | null;
}> {
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json', ...(init?.headers as Record<string, string>) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  let body: T | null = null;
  if (res.ok) {
    body = (await res.json()) as T;
  }
  return { status: res.status, body };
}

/** 拉取画像分析摘要（含每条的裁决状态）；网络失败返回 error，不打断界面 */
export async function fetchProfile(): Promise<ProfileResult> {
  void flushVerdicts(); // 顺手捎带：有未同步裁决就趁这次联网补发
  try {
    const { status, body } = await request<{
      ok: boolean;
      updatedAt: string | null;
      stats: ProfileData['stats'];
      topTags: ProfileTagRow[];
      dislikedTags: ProfileDislikeRow[];
      authorAffinity: ProfileAuthorRow[];
      sourceAffinity: Record<string, number>;
      rejectedInterests: string[];
      rejectedAuthors: string[];
      portrait: unknown;
    }>('/api/profile');
    if (status === 401) return { data: null, unauthorized: true };
    if (!body) return { data: null, error: `HTTP ${status}` };
    const data: ProfileData = {
      updatedAt: body.updatedAt ?? null,
      stats: body.stats ?? {},
      topTags: Array.isArray(body.topTags) ? body.topTags : [],
      dislikedTags: Array.isArray(body.dislikedTags) ? body.dislikedTags : [],
      authorAffinity: Array.isArray(body.authorAffinity) ? body.authorAffinity : [],
      sourceAffinity: body.sourceAffinity ?? {},
      rejectedInterests: Array.isArray(body.rejectedInterests) ? body.rejectedInterests : [],
      rejectedAuthors: Array.isArray(body.rejectedAuthors) ? body.rejectedAuthors : [],
      portrait: body.portrait ?? null,
    };
    return {
      // 服务端数据 + 盖上还没同步到服务端的本地裁决，UI 不会回跳
      data: overlayVerdicts(data, await loadPending()),
    };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export { EMPTY as EMPTY_PROFILE };
