import { API_BASE } from './config';
import { getToken } from './auth';
import type { RecommendationFeed } from '../types';

/**
 * 推荐流（为你推荐）：读 /data/recommendations.json（scraper/ranker.mjs
 * 每轮抓取后定时生成）。它是静态 JSON，与时间线分开加载，失败返回 null
 * 不影响信息流——foryou 模式此时回落最新序。
 * 与 sources.ts 同款约定：自动附加 Bearer（nginx 层 JWT 认证）。
 */
export async function loadRecommendations(): Promise<RecommendationFeed | null> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${API_BASE}/data/recommendations.json`, {
      headers,
      cache: 'no-cache',
    });
    if (!res.ok) return null;
    const feed = (await res.json()) as RecommendationFeed;
    return Array.isArray(feed.items) ? feed : null;
  } catch {
    return null;
  }
}
