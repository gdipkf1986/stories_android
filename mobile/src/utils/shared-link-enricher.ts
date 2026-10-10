import { API_BASE } from '../api/config';
import { getToken } from '../api/auth';
import {
  loadLikedItems,
  updateLikedItem,
  type LikedItem,
} from '../api/likes';
import { pushLikes } from '../api/likes-sync';
import { NORMALIZERS } from '../api/normalize';
import { sourceMeta } from '../api/sources';
import type { Metric, TimelineItem } from '../types';
import {
  canonicalUrl,
  isSharedTitleFallback,
  sharedTitleFallback,
} from './share-import';

const inFlight = new Set<string>();

type ShareDetails = Partial<Omit<LikedItem, 'id' | 'likedAt'>>;

function isSparseSharedLike(item: LikedItem): boolean {
  if (!item.id.includes(':share:') || !item.url) return false;
  const meta = sourceMeta(item.source);
  return (
    isSharedTitleFallback(item.title, item.source) ||
    item.excerpt === sharedTitleFallback(item.source) ||
    item.author === meta.label
  );
}

function differentDetails(item: LikedItem, details: ShareDetails): boolean {
  return Object.entries(details).some(([key, value]) =>
    value !== undefined && item[key as keyof LikedItem] !== value,
  );
}

function sameUrl(left: string, right: string): boolean {
  return canonicalUrl(left) === canonicalUrl(right);
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = await getToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function findTimelineItem(url: string, source: LikedItem['source']) {
  const file = sourceMeta(source).file;
  const raw = await fetchJson(`${API_BASE}${file}`);
  const items = (NORMALIZERS[source] ?? undefined)?.(raw);
  if (!items) return null;
  return items.find((candidate) => candidate.url && sameUrl(candidate.url, url)) ?? null;
}

function timelineDetails(item: TimelineItem): ShareDetails {
  return {
    author: item.author,
    title: item.title,
    excerpt: item.excerpt,
    createdAt: item.createdAt,
    metrics: item.metrics,
    tags: item.tags,
    url: item.url,
    cover: item.cover,
    feed: item.feed,
  };
}

async function fetchBilibiliVideo(url: string): Promise<ShareDetails | null> {
  const bvid = url.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
  if (!bvid) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const payload = await response.json();
    const data = (payload as { data?: Record<string, unknown> }).data;
    if (!data) return null;

    const text = (value: unknown, fallback = ''): string =>
      typeof value === 'string' && value.trim() ? value.trim() : fallback;
    const owner = data.owner as { name?: unknown } | undefined;
    const stat = data.stat as Record<string, unknown> | undefined;
    const metrics: Metric[] = [];
    if (typeof stat?.view === 'number') metrics.push({ label: '播放', value: stat.view });
    if (typeof stat?.danmaku === 'number') metrics.push({ label: '弹幕', value: stat.danmaku });
    if (typeof stat?.like === 'number') metrics.push({ label: '点赞', value: stat.like });
    const cover = text(data.pic).replace(/^http:/, 'https:');

    return {
      author: text(owner?.name, 'B站用户'),
      title: text(data.title),
      excerpt: text(data.desc) || text(data.title),
      createdAt: typeof data.pubdate === 'number' ? data.pubdate * 1000 : undefined,
      metrics,
      cover: cover || undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function metaContent(html: string, key: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i',
  );
  const tag = html.match(pattern)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content ? decodeHtml(content) : undefined;
}

async function fetchPageMetadata(url: string): Promise<ShareDetails | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const html = (await response.text()).slice(0, 300_000);
    const title = metaContent(html, 'og:title') ?? metaContent(html, 'twitter:title');
    const excerpt =
      metaContent(html, 'og:description') ?? metaContent(html, 'twitter:description');
    const cover = metaContent(html, 'og:image') ?? metaContent(html, 'twitter:image');
    if (!title && !excerpt) return null;
    return {
      title: title || undefined,
      excerpt: excerpt || title || undefined,
      cover: cover?.replace(/^http:/, 'https:'),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrich(item: LikedItem): Promise<boolean> {
  if (!item.url) return false;

  let details: ShareDetails | null = null;
  try {
    const matched = await findTimelineItem(item.url, item.source);
    details = matched ? timelineDetails(matched) : null;
  } catch {
    details = null;
  }

  if (!details && item.source === 'bilibili') {
    details = await fetchBilibiliVideo(item.url);
  }
  if (!details && item.source !== 'zhihu') {
    details = await fetchPageMetadata(item.url);
  }
  if (!details) return false;

  const cleanDetails = Object.fromEntries(
    Object.entries(details).filter(([, value]) =>
      value !== undefined && value !== null && value !== '',
    ),
  ) as ShareDetails;
  if (!differentDetails(item, cleanDetails)) return false;

  await updateLikedItem(item, cleanDetails);
  return true;
}

/** 新分享先立即收藏，再后台把占位快照换成时间线/B站 API 里能拿到的真实细节。 */
export async function enrichSharedLike(item: LikedItem): Promise<boolean> {
  if (!isSparseSharedLike(item) || inFlight.has(item.id)) return false;
  inFlight.add(item.id);
  try {
    const changed = await enrich(item);
    if (changed) await pushLikes();
    return changed;
  } catch {
    return false;
  } finally {
    inFlight.delete(item.id);
  }
}

/** 兼容旧版已落库的分享收藏：启动时串行补全，避免一次性打爆源站。 */
export async function enrichSparseSharedLikes(): Promise<number> {
  const items = (await loadLikedItems()).filter(isSparseSharedLike);
  let changed = 0;
  for (const item of items) {
    if (await enrichSharedLike(item)) changed += 1;
  }
  if (changed > 0) await pushLikes();
  return changed;
}
