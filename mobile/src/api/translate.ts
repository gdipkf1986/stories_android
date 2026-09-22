import { API_BASE } from './config';
import { getToken } from './auth';

/**
 * HN 全文按需翻译（POST /api/hn/translate）。
 *
 * 默认只下发标题+摘要的中文（批处理只做摘要，全文翻译按需省 token）；
 * 用户在卡片上点「翻译全文」时才调这个接口：服务端有缓存秒回，
 * 没缓存现场调 LLM 翻（冷启动约 30~90s），译文写回摘要库永久复用。
 *
 * 返回译文文本；失败抛错（调用方展示「翻译失败，点此重试」）。
 */
export async function translateHnArticle(itemId: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const token = await getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}/api/hn/translate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: itemId }),
  });
  const data: unknown = await res.json().catch(() => null);
  const contentZh =
    typeof data === 'object' && data !== null && 'content_zh' in data
      ? String((data as { content_zh?: unknown }).content_zh ?? '')
      : '';
  if (!res.ok || !contentZh) {
    const message =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error?: unknown }).error ?? '')
        : '';
    throw new Error(message || `HTTP ${res.status}`);
  }
  return contentZh;
}
