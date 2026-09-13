import { API_BASE } from './config';
import { getToken } from './auth';

/**
 * 画像分析 API：GET /api/profile（分析结果 + 用户裁决状态）、
 * POST /api/verdicts（对某条分析确认/反对）。
 * 与 sources.ts 同款约定：自动附加 Bearer，401 透传给上层触发登录页。
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
    return {
      data: {
        updatedAt: body.updatedAt ?? null,
        stats: body.stats ?? {},
        topTags: Array.isArray(body.topTags) ? body.topTags : [],
        dislikedTags: Array.isArray(body.dislikedTags) ? body.dislikedTags : [],
        authorAffinity: Array.isArray(body.authorAffinity) ? body.authorAffinity : [],
        sourceAffinity: body.sourceAffinity ?? {},
        rejectedInterests: Array.isArray(body.rejectedInterests) ? body.rejectedInterests : [],
        rejectedAuthors: Array.isArray(body.rejectedAuthors) ? body.rejectedAuthors : [],
        portrait: body.portrait ?? null,
      },
    };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 提交裁决：verdict 'none' 表示撤销；成功返回 true */
export async function submitVerdict(key: string, verdict: ProfileVerdict | 'none'): Promise<boolean> {
  try {
    const { status } = await request('/api/verdicts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, verdict }),
    });
    return status === 200;
  } catch {
    return false;
  }
}

export { EMPTY as EMPTY_PROFILE };
