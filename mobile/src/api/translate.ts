import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from './config';
import { getToken } from './auth';

/**
 * HN 全文后台翻译（POST 入队 + GET 状态）。免费模型翻长文经常超过反代超时，
 * 所以请求只负责提交任务；APK 记住待查询条目，在卡片重建/刷新后恢复状态并取回结果。
 */
export type HnTranslationStatus = 'queued' | 'translating' | 'done' | 'failed' | 'missing';
export type GithubTranslationStatus = HnTranslationStatus;

export interface HnTranslationResult {
  status: HnTranslationStatus;
  contentZh?: string;
  error?: string;
}
export interface GithubTranslationResult {
  status: GithubTranslationStatus;
  contentZh?: string;
  error?: string;
}

const PENDING_KEY = 'stories.hn-translations';
const PENDING_CAP = 100;

interface ApiPayload {
  ok?: boolean;
  status?: string;
  content_zh?: unknown;
  error?: unknown;
}

function asPayload(data: unknown): ApiPayload {
  return typeof data === 'object' && data !== null ? (data as ApiPayload) : {};
}

function normalizedStatus(value: string | undefined, fallback: HnTranslationStatus): HnTranslationStatus {
  return value === 'queued' || value === 'translating' || value === 'done' ||
    value === 'failed' || value === 'missing'
    ? value
    : fallback;
}

async function fetchTranslation(
  itemId: string,
  init?: RequestInit,
  search = '',
  path = '/api/hn/translate',
): Promise<HnTranslationResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}${search}`, { ...init, headers });
  const payload = asPayload(await res.json().catch(() => null));
  const status = normalizedStatus(payload.status, res.ok ? 'done' : 'failed');
  const contentZh = typeof payload.content_zh === 'string' ? payload.content_zh : '';

  if (status === 'done' && res.ok && contentZh) return { status, contentZh };
  if (res.ok && (status === 'queued' || status === 'translating')) return { status };
  if (status === 'failed' || status === 'missing') {
    return {
      status,
      error: typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`,
    };
  }
  throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${res.status}`);
}

/** 提交后台翻译；202 表示服务端已接受，HTTP 请求不再等 1 分钟 */
export async function queueHnTranslation(itemId: string): Promise<HnTranslationResult> {
  const result = await fetchTranslation(itemId, {
    method: 'POST',
    body: JSON.stringify({ id: itemId }),
  });
  if (result.status === 'queued' || result.status === 'translating') {
    await rememberPendingHnTranslation(itemId);
  }
  return result;
}

/** 查询已提交任务；完成后由卡片渲染，下一次数据同步也会从服务端摘要库带出全文 */
export async function getHnTranslation(itemId: string): Promise<HnTranslationResult> {
  const query = `?id=${encodeURIComponent(itemId.replace(/^hn:/, ''))}`;
  return fetchTranslation(itemId, { method: 'GET' }, query);
}

/** GitHub README 翻译；长文由后端队列执行，前端只轮询。 */
export async function queueGithubTranslation(itemId: string): Promise<GithubTranslationResult> {
  const result = await fetchTranslation(itemId, {
    method: 'POST',
    body: JSON.stringify({ id: itemId }),
  }, '', '/api/github/translate');
  return result as GithubTranslationResult;
}

export async function getGithubTranslation(itemId: string): Promise<GithubTranslationResult> {
  const query = `?id=${encodeURIComponent(itemId.replace(/^github:/, ''))}`;
  return fetchTranslation(itemId, { method: 'GET' }, query, '/api/github/translate') as Promise<GithubTranslationResult>;
}

async function readPendingIds(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse((await AsyncStorage.getItem(PENDING_KEY)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.startsWith('hn:'));
  } catch {
    return [];
  }
}

async function writePendingIds(ids: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify([...new Set(ids)].slice(-PENDING_CAP)));
  } catch {
    // 本地标记只是加速状态恢复，失败不影响已经入队的翻译
  }
}

export async function rememberPendingHnTranslation(itemId: string): Promise<void> {
  await writePendingIds([...(await readPendingIds()), itemId]);
}

export async function forgetPendingHnTranslation(itemId: string): Promise<void> {
  await writePendingIds((await readPendingIds()).filter((id) => id !== itemId));
}

export async function getPendingHnTranslationIds(): Promise<Set<string>> {
  return new Set(await readPendingIds());
}
