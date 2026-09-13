import { useMemo, useState } from 'react';
import type { TimelineItem } from '../../types';
import { zhihuAppLink } from '../../utils/zhihu-app';
import { trackClick, likeItem, dislikeItem, feedbackStateOf } from '../../lib/feedback';
import { resolveCardModel, type CardModel } from './cardModel';

interface Props {
  item: TimelineItem;
  /** 「为你推荐」排序下的推荐理由（ranker 模板生成），缺省不显示 */
  reason?: string;
  /** 探索位标记（画像里没见过的方向），显示一个小徽标 */
  explore?: boolean;
  /** 用户点了「不感兴趣」→ 由列表当场移除卡片 */
  onDislike?: (itemId: string) => void;
}

/**
 * FeedCard —— 全项目唯一的条目卡片组件（web/DOM 实现，安卓端为 RN 版 FeedCard）。
 *
 * 任何数据源（知乎/B站/未来新源）的任何子板块，条目一律由它渲染：
 * TimelineItem 经 cardModel.resolveCardModel（与 mobile 端互为镜像）解析成 CardModel，
 * 本组件只负责照模型画，不出现任何 `item.source === 'xxx'` 的分支。
 * 各源长相差异只走 sources.ts 注册表的 card: CardVisual，禁止为新源另写卡片。
 *
 * 平台差异保留在视图层（属「怎么画」而非「画什么」）：
 *  - 知乎链接仍走 zhihuAppLink（移动浏览器深链进 <a href>，桌面新标签打开）；
 *  - 反馈按钮用 <button> + 本地 feedback 状态（web 端 cookie 上报）。
 */
export default function FeedCard({ item, reason, explore, onDislike }: Props) {
  // item/推荐位不变则模型不变；解析出「画什么」，本组件只管「怎么画」
  const model: CardModel = useMemo(
    () => resolveCardModel(item, { reason, explore }),
    [item, reason, explore],
  );
  /** 封面加载失败 → 隐藏图，退化为纯文字卡片 */
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = Boolean(model.cover) && !coverFailed;
  const rec = model.recommendation;

  /** 手机上点知乎链接直接唤起知乎 App（深链放 href，Edge 等浏览器也兼容）；桌面保持原样 */
  const link = model.openable ? zhihuAppLink(item.url as string) : null;
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
        <span className="avatar" style={{ background: model.author.color }}>
          {model.author.initial}
        </span>
        <div className="card-head-text">
          <span className="card-author">{model.author.name}</span>
          <span className="card-kind">{model.kindText}</span>
        </div>
        <span className="source-badge" style={{ color: model.badge.color }}>
          {model.badge.label}
        </span>
      </header>

      {showCover && model.cover && (
        <img
          className="card-cover"
          src={model.cover.uri}
          alt=""
          loading="lazy"
          style={{ aspectRatio: String(model.cover.aspect) }}
          onError={() => setCoverFailed(true)}
        />
      )}

      <h2 className="card-title">
        {link ? (
          <a
            className="card-title-link"
            href={link.href}
            target={link.target}
            rel="noreferrer"
            onClick={handleClick}
          >
            {model.title}
          </a>
        ) : (
          model.title
        )}
      </h2>
      {model.excerpt !== null && <p className="card-excerpt">{model.excerpt}</p>}

      {rec && (
        <div className="card-reason">
          {rec.explore && <span className="reason-explore">探索</span>}
          {rec.reason && <span className="reason-text">{rec.reason}</span>}
        </div>
      )}

      {model.tags.length > 0 && (
        <div className="card-tags">
          {model.tags.map((tag) => (
            <span key={tag} className="card-tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      <footer className="card-foot">
        <span className="card-time">{model.timeText}</span>
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
          {model.metrics.map((m) => (
            <button key={m.label} className="metric">
              {m.label} {m.value}
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
