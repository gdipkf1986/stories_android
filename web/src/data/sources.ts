import type {
  SourceId,
  SourceMeta,
  TimelineItem,
  TimelineLoadResult,
} from '../types';
import { NORMALIZERS } from './normalize';

/**
 * 所有数据源的注册表（mobile/src/api/sources.ts 的镜像）。
 * 要接入新数据源：public/data/ 放 JSON → normalize.ts 写适配器 → 这里加一条。
 * 卡片渲染零改动：FeedCard 对所有源/子板块通用，最多给该源配一个 card: CardVisual 微调长相
 * （见 mobile/src/components/card/README.md；不配置则全默认渲染）。
 */
export const SOURCES: SourceMeta[] = [
  {
    id: 'zhihu',
    label: '知乎推荐流',
    kind: '发布了内容',
    color: '#eb5f4a',
    file: '/data/zhihu-feed.json',
    feeds: [
      { id: 'recommend', label: '推荐' },
      { id: 'follow', label: '关注' },
      { id: 'hot', label: '热榜' },
    ],
  },
  {
    id: 'answers',
    label: '知乎回答',
    kind: '发布了回答',
    color: '#0084ff',
    file: '/data/answers.json',
  },
  {
    id: 'news',
    label: '科技资讯',
    kind: '发布了资讯',
    color: '#ff9607',
    file: '/data/news.json',
  },
  {
    id: 'blogs',
    label: '博客专栏',
    kind: '发表了文章',
    color: '#175199',
    file: '/data/blogs.json',
  },
  {
    id: 'bilibili',
    label: 'B站',
    kind: '发布了视频',
    color: '#fb7299', // B站品牌粉
    file: '/data/bilibili-feed.json',
    feeds: [
      { id: 'popular', label: '热门' },
      { id: 'rank', label: '排行榜' },
    ],
    // 卡片视觉：B站条目带封面，锁定标准 16:9（缺省值，写出来是给新源当参照）
    card: { coverAspect: 16 / 9 },
  },
];

/**
 * 并发加载所有数据源 → 各自归一化 → 合并 → 按时间倒序。
 * 用 Promise.allSettled 保证单个源加载失败不影响其他源，
 * 失败信息收集起来，由 UI 提示。
 */
export async function loadTimeline(): Promise<TimelineLoadResult> {
  const settled = await Promise.allSettled(
    SOURCES.map(async (source) => {
      const res = await fetch(source.file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw: unknown = await res.json();
      return NORMALIZERS[source.id](raw);
    }),
  );

  const items: TimelineItem[] = [];
  const failures: TimelineLoadResult['failures'] = [];

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      const source = SOURCES[i];
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push({ source: source.id, reason });
    }
  });

  items.sort((a, b) => b.createdAt - a.createdAt);
  return { items, failures };
}

/** 按 id 取数据源元信息 */
export function sourceMeta(id: SourceId): SourceMeta {
  return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
}
