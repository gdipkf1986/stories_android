import type {
  SourceId,
  SourceMeta,
  TimelineItem,
  TimelineLoadResult,
} from '../types';
import { NORMALIZERS } from './normalize';
import { API_BASE } from './config';
import { getToken } from './auth';

/**
 * 所有数据源的注册表（与 stories web 端保持一致）。
 * 要接入新数据源：后端 public/data/ 放 JSON → normalize.ts 写适配器 → 这里加一条。
 * 卡片渲染零改动：FeedCard 对所有源/子板块通用，最多给该源配一个 card: CardVisual 微调长相
 * （见 components/card/README.md；不配置则全默认渲染）。
 */
export const SOURCES: SourceMeta[] = [
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
];

/**
 * 并发加载所有数据源 → 各自归一化 → 合并 → 按时间倒序。
 * 用 Promise.allSettled 保证单个源加载失败不影响其他源，
 * 失败信息收集起来，由 UI 提示。
 * 已保存 JWT 时自动附加 Authorization: Bearer；任一源返回 401 → unauthorized=true（触发登录页）。
 */
export async function loadTimeline(): Promise<TimelineLoadResult> {
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const settled = await Promise.allSettled(
    SOURCES.map(async (source) => {
      const res = await fetch(`${API_BASE}${source.file}`, { headers });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const raw: unknown = await res.json();
      return NORMALIZERS[source.id](raw);
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
  return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
}

/** 源在最新流里的交错权重（未配置/未注册的源一律回落 1，新源零配置接入） */
export function sourceWeight(id: string): number {
  const w = SOURCES.find((s) => s.id === id)?.weight;
  return typeof w === 'number' && w > 0 ? w : 1;
}
