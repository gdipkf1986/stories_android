import { useMemo } from 'react';
import type { TimelineItem } from '../types';
import { formatCount, hotScore } from '../utils/format';

/** 右侧栏：按热度排出的“热门内容” */
export default function HotTopics({ items }: { items: TimelineItem[] }) {
  const hot = useMemo(
    () => [...items].sort((a, b) => hotScore(b) - hotScore(a)).slice(0, 5),
    [items],
  );

  return (
    <aside className="topics">
      <div className="side-card">
        <h3 className="topics-title">热门内容</h3>
        {hot.map((item, i) => (
          <div key={item.id} className="topic-item" title={item.title}>
            <span className="topic-rank">{i + 1}</span>
            <span className="topic-text">{item.title}</span>
            <span className="topic-score">{formatCount(hotScore(item))} 热度</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
