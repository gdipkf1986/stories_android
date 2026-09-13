import { useState } from 'react';
import type { TimelineItem } from '../types';
import { sourceMeta } from '../data/sources';
import { avatarColorFor } from '../data/normalize';
import { formatCount, formatRelativeTime } from '../utils/format';
import { zhihuAppLink } from '../utils/zhihu-app';
import { trackClick, likeItem, dislikeItem, feedbackStateOf } from '../lib/feedback';

interface Props {
  item: TimelineItem;
  /** 「为你推荐」排序下的推荐理由（ranker 模板生成），缺省不显示 */
  reason?: string;
  /** 探索位标记（画像里没见过的方向），显示一个小徽标 */
  explore?: boolean;
  /** 用户点了「不感兴趣」→ 由列表当场移除卡片 */
  onDislike?: (itemId: string) => void;
}

/** 单条时间线卡片：归一化后的 TimelineItem 已经足够渲染，不需要关心它来自哪个源 */
export default function TimelineCard({ item, reason, explore, onDislike }: Props) {
  const meta = sourceMeta(item.source);
  /** 手机上点知乎链接直接唤起知乎 App（深链放 href，Edge 等浏览器也兼容）；桌面保持原样 */
  const link = item.url ? zhihuAppLink(item.url) : null;
  const [fb, setFb] = useState(feedbackStateOf(item.id));

  const handleClick = () => trackClick(item); // 埋点不拦截跳转

  const handleLike = () => {
    if (fb === 'dislike') return; // 踩过的不反悔成赞，需要的是确定性修正（暂不做）
    setFb(likeItem(item));
  };

  const handleDislike = () => {
    setFb(dislikeItem(item));
    onDislike?.(item.id); // 当场移出信息流（软信号：画像层 48h 冷却，非永久拉黑）
  };

  return (
    <article className="card">
      <header className="card-head">
        <span className="avatar" style={{ background: avatarColorFor(item.author) }}>
          {item.author.slice(0, 1)}
        </span>
        <div className="card-head-text">
          <span className="card-author">{item.author}</span>
          <span className="card-kind">{item.kind ?? meta.kind}</span>
        </div>
        <span className="source-badge" style={{ color: meta.color }}>
          {meta.label}
        </span>
      </header>

      <h2 className="card-title">
        {link ? (
          <a
            className="card-title-link"
            href={link.href}
            target={link.target}
            rel="noreferrer"
            onClick={handleClick}
          >
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h2>
      <p className="card-excerpt">{item.excerpt}</p>

      {(reason || explore) && (
        <div className="card-reason">
          {explore && <span className="reason-explore">探索</span>}
          {reason && <span className="reason-text">{reason}</span>}
        </div>
      )}

      {item.tags.length > 0 && (
        <div className="card-tags">
          {item.tags.map((tag) => (
            <span key={tag} className="card-tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      <footer className="card-foot">
        <span className="card-time">{formatRelativeTime(item.createdAt)}</span>
        {link && (
          <a
            className="card-link"
            href={link.href}
            target={link.target}
            rel="noreferrer"
            onClick={handleClick}
          >
            查看原文 ↗
          </a>
        )}
        <div className="card-metrics">
          {item.metrics.map((m) => (
            <button key={m.label} className="metric">
              {m.label} {formatCount(m.value)}
            </button>
          ))}
        </div>
      </footer>

      <div className="card-actions">
        <button
          className={fb === 'like' ? 'action-btn liked' : 'action-btn'}
          onClick={handleLike}
          aria-pressed={fb === 'like'}
          title={fb === 'like' ? '已喜欢' : '喜欢'}
        >
          ♡ 喜欢
        </button>
        <button
          className={fb === 'dislike' ? 'action-btn disliked' : 'action-btn'}
          onClick={handleDislike}
          title="不感兴趣（可少推同类）"
        >
          ✕ 不感兴趣
        </button>
      </div>
    </article>
  );
}
