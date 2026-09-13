import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RecommendationFeed, SortMode, SourceId, TimelineItem, TimelineLoadResult } from './types';
import { loadTimeline, sourceMeta } from './data/sources';
import { hotScore } from './utils/format';
import { initFeedback } from './lib/feedback';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import FeedCard from './components/card/FeedCard';
import HotTopics from './components/HotTopics';
import ProfilePanel from './components/ProfilePanel';

type Filter = SourceId | 'all';
type View = 'feed' | 'profile';

/** 推荐流是静态 JSON（ranker 定时生成），单独加载，失败不影响时间线 */
async function loadRecommendations(): Promise<RecommendationFeed | null> {
  try {
    const res = await fetch('/data/recommendations.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const feed = (await res.json()) as RecommendationFeed;
    return Array.isArray(feed.items) ? feed : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [data, setData] = useState<TimelineLoadResult>({ items: [], failures: [] });
  const [recFeed, setRecFeed] = useState<RecommendationFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortMode>('latest');
  /** 本会话内被点了「不感兴趣」的卡片：当场隐藏（软信号，画像层会衰减） */
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>('feed');

  useEffect(() => {
    initFeedback();
    Promise.all([loadTimeline(), loadRecommendations()])
      .then(([timeline, recs]) => {
        setData(timeline);
        setRecFeed(recs);
      })
      .finally(() => setLoading(false));
  }, []);

  /** 左侧栏各来源的条目数 */
  const counts = useMemo(() => {
    const map = new Map<SourceId, number>();
    for (const item of data.items) {
      map.set(item.source, (map.get(item.source) ?? 0) + 1);
    }
    return map;
  }, [data.items]);

  /** 推荐条目索引：id → 推荐元信息（分数/理由/探索位） */
  const recIndex = useMemo(() => {
    const map = new Map<string, { score: number; reason: string; explore: boolean }>();
    for (const r of recFeed?.items ?? []) {
      map.set(r.id, { score: r.score, reason: r.reason, explore: r.explore });
    }
    return map;
  }, [recFeed]);

  /** 先按来源过滤，再按排序模式排列 */
  const visible = useMemo(() => {
    const alive = (list: TimelineItem[]) => list.filter((i) => !dismissed.has(i.id));
    const list = filter === 'all' ? data.items : data.items.filter((i) => i.source === filter);
    if (sort === 'hot') return alive([...list].sort((a, b) => hotScore(b) - hotScore(a)));
    if (sort === 'foryou') {
      // 只保留推荐流里有的条目，按推荐顺序输出；推荐流为空时回落时间序
      const ordered = (recFeed?.items ?? [])
        .map((r) => data.items.find((i) => i.id === r.id))
        .filter((i): i is TimelineItem => Boolean(i));
      return alive(filter === 'all' ? ordered : ordered.filter((i) => i.source === filter));
    }
    return alive(list);
  }, [data.items, filter, sort, recFeed, dismissed]);

  const handleDislike = useCallback((itemId: string) => {
    setDismissed((prev) => new Set(prev).add(itemId));
  }, []);

  const toggleProfile = useCallback(() => {
    setView((v) => (v === 'feed' ? 'profile' : 'feed'));
  }, []);

  if (view === 'profile') {
    return (
      <div className="app">
        <Navbar view="profile" onToggleProfile={toggleProfile} />
        <div className="container profile-container">
          <main className="feed">
            <ProfilePanel />
          </main>
        </div>
        <footer className="footer">stories · 多源 JSON 聚合时间线 · TypeScript + React</footer>
      </div>
    );
  }

  return (
    <div className="app">
      <Navbar view="feed" onToggleProfile={toggleProfile} />

      <div className="container">
        <Sidebar active={filter} counts={counts} total={data.items.length} onSelect={setFilter} />

        <main className="feed">
          <div className="feed-tabs">
            <button
              className={sort === 'latest' ? 'tab active' : 'tab'}
              onClick={() => setSort('latest')}
            >
              最新
            </button>
            <button
              className={sort === 'hot' ? 'tab active' : 'tab'}
              onClick={() => setSort('hot')}
            >
              热门
            </button>
            <button
              className={sort === 'foryou' ? 'tab active' : 'tab'}
              onClick={() => setSort('foryou')}
            >
              为你推荐
            </button>
          </div>

          {loading && <div className="feed-status">加载中…</div>}

          {!loading && data.failures.length > 0 && (
            <div className="feed-warning">
              ⚠️{' '}
              {data.failures
                .map((f) => `${sourceMeta(f.source).label} 加载失败（${f.reason}）`)
                .join('；')}
            </div>
          )}

          {!loading && sort === 'foryou' && (recFeed?.coldStart ?? false) && (
            <div className="feed-warning">
              💡 画像还是空的：多点「喜欢 / 不感兴趣」，排序会越来越懂你（每次抓取后自动更新）
            </div>
          )}

          {!loading && visible.length === 0 && <div className="feed-status">暂无内容</div>}

          {visible.map((item) => {
            const rec = recIndex.get(item.id);
            return (
              <FeedCard
                key={item.id}
                item={item}
                reason={sort === 'foryou' ? rec?.reason : undefined}
                explore={sort === 'foryou' ? rec?.explore : undefined}
                onDislike={handleDislike}
              />
            );
          })}
        </main>

        <HotTopics items={data.items} />
      </div>

      <footer className="footer">stories · 多源 JSON 聚合时间线 · TypeScript + React</footer>
    </div>
  );
}
