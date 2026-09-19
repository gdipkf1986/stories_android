/** 数据源标识（与 stories web 端保持一致） */
export type SourceId = 'zhihu' | 'bilibili' | 'github';

/** 子板块元信息（源内细分流，如知乎 recommend/follow/hot、B站 popular/rank） */
export interface FeedMeta {
  id: string; // 子板块标识 = 抓取 JSON 里 feeds[].source 字段
  label: string; // 界面显示名
}

/**
 * 卡片视觉配置：一个数据源在 FeedCard 里的「非默认」长相。
 * 只放真正因源而异的展示参数，缺省值见 components/card/cardModel.ts 的 DEFAULT_CARD_VISUAL。
 * 新数据源不配置也能渲染（全部走缺省），配置了也只是微调，**不允许**为新源另写卡片组件。
 */
export interface CardVisual {
  /** 封面图宽高比（宽/高），缺省 16:9（B站封面标准） */
  coverAspect?: number;
  /** 底部指标最多展示几个，缺省 3 */
  maxMetrics?: number;
}

/** 数据源元信息（展示用） */
export interface SourceMeta {
  id: SourceId;
  label: string; // 在界面上显示的来源名
  kind: string; // 动作描述，如“发布了回答”
  color: string; // 来源徽标颜色
  file: string; // JSON 路径（拼在 API_BASE 后）
  feeds?: FeedMeta[]; // 子板块列表（多抓取流的源才配置，供筛选下拉用）
  card?: CardVisual; // 卡片视觉微调（缺省 = FeedCard 全默认渲染）
  /** 最新流的展示权重（加权交错用，缺省 1；如 zhihu=2、bilibili=1 → 知乎出现频率是 B站两倍） */
  weight?: number;
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
  cover?: string; // 封面图 URL（B站视频等有封面的条目），https
  feed?: string; // 源内子板块（zhihu: recommend/follow/hot；bilibili: popular/rank/home），供筛选下拉用
}

/** 数据加载结果：单个源挂掉不影响整体，失败信息单独收集 */
export interface TimelineLoadResult {
  items: TimelineItem[];
  failures: { source: SourceId; reason: string }[];
  /** 任一数据源返回 401：token 缺失或失效，需要重新登录 */
  unauthorized?: boolean;
}

/** 排序模式：最新 / 热门 / 为你推荐（画像排序） */
export type SortMode = 'latest' | 'hot' | 'foryou';

/** 来源筛选：'all' 或某个具体数据源 */
export type SourceFilter = SourceId | 'all';

/** 推荐流条目（/data/recommendations.json，scraper/ranker.mjs 定时生成） */
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
