/** 数据源标识 */
export type SourceId = 'zhihu' | 'answers' | 'news' | 'blogs';

/** 数据源元信息（展示用） */
export interface SourceMeta {
  id: SourceId;
  label: string; // 在界面上显示的来源名
  kind: string; // 动作描述，如“发布了回答”
  color: string; // 来源徽标颜色
  file: string; // JSON 文件路径
}

/** 归一化后的指标（赞同 / 评论 / 阅读……） */
export interface Metric {
  label: string;
  value: number;
}

/**
 * 统一时间线条目。
 * 任何数据源的 JSON 都会被适配器归一化成这个结构，UI 只认它。
 */
export interface TimelineItem {
  id: string; // 全局唯一，格式 `${source}:${原始id}`
  source: SourceId;
  author: string;
  title: string;
  excerpt: string;
  createdAt: number; // 毫秒时间戳
  metrics: Metric[];
  tags: string[];
  kind?: string; // 每条的动作文案，缺省时用数据源的 kind
  url?: string; // 原文链接（可选）
}

/** 数据加载结果：单个源挂掉不影响整体，失败信息单独收集 */
export interface TimelineLoadResult {
  items: TimelineItem[];
  failures: { source: SourceId; reason: string }[];
}

/** 排序模式：最新 / 热门 / 为你推荐（画像排序） */
export type SortMode = 'latest' | 'hot' | 'foryou';

/** 推荐流条目（public/data/recommendations.json，scraper/ranker.mjs 生成） */
export interface RecommendationEntry {
  id: string;
  source: string;
  score: number;
  explore: boolean;
  matchedTags: string[];
  reason: string;
}

export interface RecommendationFeed {
  version: number;
  generatedAt: string;
  coldStart: boolean;
  windowDays: number;
  items: RecommendationEntry[];
}
