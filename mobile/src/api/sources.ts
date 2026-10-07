import type {
  SourceId,
  SourceMeta,
  TimelineItem,
  TimelineLoadResult,
} from '../types';
import { NORMALIZERS, normalizeGenericFeed } from './normalize';
import { API_BASE } from './config';
import { getToken } from './auth';

/**
 * 所有数据源的注册表（与 stories web 端保持一致）。
 * 要接入新数据源：后端 public/data/ 放 JSON → normalize.ts 写适配器 → 这里加一条。
 * 卡片渲染零改动：FeedCard 对所有源/子板块通用，最多给该源配一个 card: CardVisual 微调长相
 * （见 components/card/README.md；不配置则全默认渲染）。
 */
const FALLBACK_SOURCES: SourceMeta[] = [
  {
    id: 'zhihu',
    label: '知乎',
    kind: '发布了内容',
    color: '#eb5f4a',
    file: '/data/zhihu-feed.json',
    weight: 1, // 最新流交错权重
    // 子板块 = 抓取 JSON 里 feeds[].source（scraper/zhihu-feed.mjs 的 --tabs）
    feeds: [
      { id: 'recommend', label: '推荐' },
      { id: 'follow', label: '关注' },
      { id: 'hot', label: '热榜' },
    ],
  },
  {
    id: 'bilibili',
    label: 'B站',
    kind: '发布了视频',
    color: '#fb7299', // B站品牌粉
    file: '/data/bilibili-feed.json',
    weight: 1, // 最新流交错权重
    // 子板块 = 抓取 JSON 里 feeds[].source（scraper/bilibili-feed.mjs 的 --tabs）
    feeds: [
      { id: 'home', label: '推荐' },
      { id: 'popular', label: '热门' },
      { id: 'rank', label: '排行榜' },
    ],
    // 卡片视觉：B站条目带封面，锁定标准 16:9（不配则也是这个缺省，写出来是给新源当参照）
    card: { coverAspect: 16 / 9 },
  },
  {
    id: 'github',
    label: 'GitHub',
    kind: '登上趋势榜',
    color: '#1f6feb', // GitHub 品牌蓝（纯黑在深色卡片上不显）
    file: '/data/github-feed.json',
    weight: 1, // 最新流交错权重
    // 子板块 = 抓取 JSON 里 feeds[].source（scraper/github-trending.mjs 的 --tabs，
    // 默认只抓 daily；要上 weekly/monthly 时在抓取端加 tab，这里同步注册）
    feeds: [{ id: 'daily', label: '日榜' }],
    // 仓库无封面图，走全默认卡片渲染，不配 card
  },
  {
    id: 'weibo',
    label: '微博',
    kind: '登上热搜',
    color: '#e6162d', // 微博品牌红
    file: '/data/weibo-feed.json',
    weight: 1, // 最新流交错权重
    // 子板块 = 抓取 JSON 里 feeds[].source（scraper/weibo-hot.mjs，固定 hot 一路）
    feeds: [{ id: 'hot', label: '热搜' }],
    // 热搜条目无封面图，走全默认卡片渲染，不配 card
  },
  {
    id: 'hn',
    label: 'Hacker News',
    kind: '登上热榜',
    color: '#ff6600', // HN 品牌橙
    file: '/data/hn-feed.json',
    weight: 1, // 最新流交错权重
    // 子板块 = 抓取 JSON 里 feeds[].source（scraper/hn-hot.mjs，固定 top/best 两路）
    feeds: [
      { id: 'top', label: '热榜' },
      { id: 'best', label: '最佳' },
    ],
    // 条目无封面图，走全默认卡片渲染，不配 card
  },
  {
    id: 'ifanr',
    label: '爱范儿',
    kind: '发布了文章',
    color: '#00b389', // 爱范儿品牌绿
    file: '/data/ifanr-feed.json',
    weight: 1,
    feeds: [{ id: 'latest', label: '最新' }],
  },
];

let SOURCES: SourceMeta[] = FALLBACK_SOURCES;
const sourceListeners = new Set<() => void>();

export function getSources(): SourceMeta[] {
  return SOURCES;
}

export function subscribeSourceRegistry(listener: () => void): () => void {
  sourceListeners.add(listener);
  return () => sourceListeners.delete(listener);
}

/** 拉取后端实际可用源；失败时保留内置清单，保证旧后端/离线兜底可用 */
export async function loadSourceRegistry(): Promise<void> {
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/sources`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const payload: unknown = await res.json();
  const root = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
  const rawSources = Array.isArray(root.sources) ? root.sources : [];
  const sources: SourceMeta[] = [];
  for (const raw of rawSources) {
    if (typeof raw !== 'object' || raw === null) continue;
    const value = raw as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id : '';
    const file = typeof value.file === 'string' ? value.file : '';
    if (!id || !file || value.available === false) continue;
    sources.push({
      id,
      file: file.startsWith('/') ? file : `/data/${file}`,
      label: typeof value.label === 'string' ? value.label : id,
      kind: typeof value.kind === 'string' ? value.kind : '发布了内容',
      color: typeof value.color === 'string' ? value.color : '#0084ff',
      feeds: Array.isArray(value.feeds)
        ? value.feeds.flatMap((feed) => {
            if (typeof feed !== 'object' || feed === null) return [];
            const item = feed as Record<string, unknown>;
            return typeof item.id === 'string' && typeof item.label === 'string'
              ? [{ id: item.id, label: item.label }]
              : [];
          })
        : undefined,
      card: typeof value.card === 'object' && value.card !== null
        ? value.card as SourceMeta['card']
        : undefined,
      weight: typeof value.weight === 'number' && value.weight > 0 ? value.weight : 1,
      available: true,
      itemCount: typeof value.itemCount === 'number' ? value.itemCount : undefined,
    });
  }
  if (sources.length > 0) {
    SOURCES = sources;
    sourceListeners.forEach((listener) => listener());
  }
}

/**
 * 并发加载所有数据源 → 各自归一化 → 合并 → 按时间倒序。
 * 用 Promise.allSettled 保证单个源加载失败不影响其他源，
 * 失败信息收集起来，由 UI 提示。
 * 已保存 JWT 时自动附加 Authorization: Bearer；任一源返回 401 → unauthorized=true（触发登录页）。
 */
export async function loadTimeline(): Promise<TimelineLoadResult> {
  try {
    await loadSourceRegistry();
  } catch {
    // 清单失败不阻塞时间线：回落内置源
  }

  const sources = getSources();
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const res = await fetch(`${API_BASE}${source.file}`, { headers });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const raw: unknown = await res.json();
      return (NORMALIZERS[source.id] ?? normalizeGenericFeed(source.id))(raw);
    }),
  );

  const items: TimelineItem[] = [];
  const failures: TimelineLoadResult['failures'] = [];
  let unauthorized = false;

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      const source = SOURCES[i];
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push({ source: source.id, reason });
      if ((result.reason as { status?: number })?.status === 401) {
        unauthorized = true;
      }
    }
  });

  items.sort((a, b) => b.createdAt - a.createdAt);
  return { items, failures, unauthorized };
}

/** 按 id 取数据源元信息 */
export function sourceMeta(id: SourceId): SourceMeta {
  return getSources().find((s) => s.id === id) ?? getSources()[0];
}

/** 源在最新流里的交错权重（未配置/未注册的源一律回落 1，新源零配置接入） */
export function sourceWeight(id: string): number {
  const w = getSources().find((s) => s.id === id)?.weight;
  return typeof w === 'number' && w > 0 ? w : 1;
}
