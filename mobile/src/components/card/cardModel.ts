import type { CardVisual, TimelineItem } from '../../types';
import { sourceMeta } from '../../api/sources';
import { avatarColorFor } from '../../api/normalize';
import { formatCount, formatRelativeTime } from '../../utils/format';

/*
 * FeedCard 的视图模型（纯函数，无 JSX、无 RN 依赖）。
 *
 * 这是「一张卡片打天下」的抽象核心：任何数据源的 TimelineItem 在这里被解析成
 * 卡片要画的每一块（头像 / 徽标 / 封面 / 标题 / 摘要 / 指标 / 标签 / 推荐位），
 * FeedCard.tsx 只照着模型渲染，**不出现任何按 source 分支的展示逻辑**。
 *
 * 各源差异有两个合法出口，都不用改卡片：
 *   1. 数据差异   → normalize.ts 适配器映射成 TimelineItem 的公共字段；
 *   2. 长相差异   → sources.ts 注册表里该源的 card: CardVisual 微调（封面比例等）。
 *
 * ⚠️ 一卡到底约定：源内所有子板块（zhihu:recommend/follow/hot、bilibili:popular/rank…）
 *    以及未来任何新数据源，一律由 FeedCard 渲染，禁止为新源另写卡片组件。
 *    接入步骤见同目录 README.md。
 */

/** 卡片缺省视觉：不配置 card 字段的数据源长这样 */
export const DEFAULT_CARD_VISUAL: Required<CardVisual> = {
  coverAspect: 16 / 9, // B站封面标准比例
  maxMetrics: 3,
};

/** 合并某数据源的卡片视觉配置（注册表缺省 → DEFAULT_CARD_VISUAL） */
export function cardVisualOf(visual?: CardVisual): Required<CardVisual> {
  return { ...DEFAULT_CARD_VISUAL, ...visual };
}

/** 底部指标（已格式化成「88万」这类可读文本） */
export interface CardMetricVM {
  label: string;
  value: string;
}

/** 推荐位（「为你推荐」排序）：ranker 生成的理由 + 探索位标记，都没有则不展示 */
export interface CardRecommendationVM {
  reason: string | null;
  explore: boolean;
}

/**
 * 卡片视图模型：FeedCard 渲染所需的全部信息，与数据源彻底解耦。
 */
export interface CardModel {
  badge: { label: string; color: string }; // 右上角来源徽标（知乎/B站…）
  author: { name: string; initial: string; color: string }; // 首字头像
  kindText: string; // 动作文案：「回答了问题」等
  timeText: string; // 相对时间：「3 小时前」
  title: string; // 空串 = 不渲染标题行
  excerpt: string | null; // null = 不渲染摘要（封面场景下与标题重复时已去重）
  cover: { uri: string; aspect: number } | null; // null = 无封面纯文字卡
  metrics: CardMetricVM[];
  tags: string[];
  openable: boolean; // 有原文链接才可点开
  recommendation: CardRecommendationVM | null; // null = 不渲染推荐位
}

/**
 * TimelineItem → CardModel。
 * @param rec 「为你推荐」排序下该条目的推荐信息（App 层从 recommendations.json 查得）
 */
export function resolveCardModel(
  item: TimelineItem,
  rec?: { reason?: string; explore?: boolean },
): CardModel {
  const meta = sourceMeta(item.source);
  const visual = cardVisualOf(meta.card);

  // B站抓取的摘要常与标题相同：有封面时重复展示很啰嗦，去重跳过
  const showExcerpt =
    !!item.excerpt && !(item.cover && item.excerpt.trim() === item.title.trim());

  const hasRec = Boolean(rec?.reason) || Boolean(rec?.explore);

  return {
    badge: { label: meta.label, color: meta.color },
    author: {
      name: item.author,
      initial: item.author.slice(0, 1),
      color: avatarColorFor(item.author),
    },
    kindText: item.kind ?? meta.kind,
    timeText: formatRelativeTime(item.createdAt),
    title: item.title,
    excerpt: showExcerpt ? item.excerpt : null,
    cover: item.cover ? { uri: item.cover, aspect: visual.coverAspect } : null,
    metrics: item.metrics.slice(0, visual.maxMetrics).map((m) => ({
      label: m.label,
      value: formatCount(m.value),
    })),
    tags: item.tags,
    openable: Boolean(item.url),
    recommendation: hasRec
      ? { reason: rec?.reason ?? null, explore: Boolean(rec?.explore) }
      : null,
  };
}
