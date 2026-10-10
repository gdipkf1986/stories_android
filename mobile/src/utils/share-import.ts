import { Platform } from 'react-native';
import { sourceMeta } from '../api/sources';
import type { SourceId, TimelineItem } from '../types';

const URL_PATTERN = /https?:\/\/[^\s<>"'）】]+/gi;
const TRACKING_PARAM = /^(utm_|share_|from$|fr$|bbid$|ts$|timestamp$|refer$|referrer$)/i;

/** Android 分享文本形如“《标题》 https://… #知乎”，先抽出可打开的 HTTP(S) 链接。 */
export function extractSharedUrl(text: string): string | null {
  if (Platform.OS !== 'android') return null;
  const url = text.match(URL_PATTERN)?.[0].replace(/[.,;:!?。，；：！？]+$/g, '');
  return url || null;
}

function sourceForUrl(url: URL): SourceId | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host.endsWith('zhihu.com')) return 'zhihu';
  if (host.endsWith('bilibili.com') || host === 'b23.tv') return 'bilibili';
  if (host.endsWith('github.com')) return 'github';
  if (host.endsWith('weibo.com') || host === 't.cn') return 'weibo';
  if (host.endsWith('news.ycombinator.com')) return 'hn';
  if (host.endsWith('ifanr.com')) return 'ifanr';
  return null;
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 33) ^ value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function canonicalUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    url.protocol = 'https:';
    const path = url.pathname.replace(/\/+$/, '');
    const search = url.searchParams.toString();
    return `${url.origin}${path}${search ? `?${search}` : ''}`;
  } catch {
    return rawUrl;
  }
}

function deriveSharedTitle(text: string, url: string, fallback: string): string {
  const remainder = text
    .replace(url, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(《|"|“|『|\[)/, '')
    .replace(/(》|"|”|』|\])$/, '')
    .replace(/\s*[-–—|]\s*(知乎|哔哩哔哩|bilibili)\s*$/i, '')
    .trim();
  return remainder || fallback;
}

export function sharedTitleFallback(source: SourceId): string {
  return `${sourceMeta(source).label}内容`;
}

export function isSharedTitleFallback(title: string, source: SourceId): boolean {
  return title === sharedTitleFallback(source);
}

/**
 * 分享链接本身携带的标题通常已经足够阅读；没有时间线元数据时收藏快照仍能永久保留原文链接。
 * 用规范化 URL 生成稳定 ID，重复分享同一条链接会按现有收藏逻辑刷新置顶时间。
 */
export function sharedLinkToItem(
  sharedText: string,
  sharedTitle?: string | null,
): TimelineItem | null {
  const rawUrl = extractSharedUrl(sharedText);
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    const source = sourceForUrl(parsed);
    if (!source) return null;

    const url = canonicalUrl(rawUrl);
    const meta = sourceMeta(source);
    const title = sharedTitle?.trim() || deriveSharedTitle(sharedText, rawUrl, sharedTitleFallback(source));
    return {
      id: `${source}:share:${stableHash(url)}`,
      source,
      author: meta.label,
      title,
      excerpt: title,
      createdAt: Date.now(),
      metrics: [],
      tags: [],
      url,
    };
  } catch {
    return null;
  }
}
