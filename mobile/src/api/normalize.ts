import type { Metric, SourceId, TimelineItem } from '../types';

/*
 * 各数据源的 JSON 结构完全不同（与 stories web 端同一套适配逻辑）：
 *  - zhihu-feed.json:      { scraped_at, feeds: [{ source, items: [{ id, type, title, excerpt, author: { name }, url, voteup, comment_count, created_time }] }] }
 *  - bilibili-feed.json:   { scraped_at, feeds: [{ source, items: [{ id, type, title, excerpt, author: { name }, url, view, danmaku, voteup, created_time }] }] }（结构与 zhihu-feed 同构）
 *  - github-feed.json:     { scraped_at, feeds: [{ source, items: [{ id: "owner/name", type: "trending", rank, title, excerpt, summary?, author: { name }, url, language, stars, forks, stars_period, period }] }] }（无时间字段，createdAt 回落 scraped_at；summary 为 LLM 生成的中文介绍，展示优先于 excerpt）
 *  - weibo-feed.json:      { scraped_at, feeds: [{ source, items: [{ id: 热搜词, type: "hot", rank, title, excerpt, label, heat, author: { name }, url }] }] }（结构与 zhihu-feed 同构；无时间字段，createdAt 回落 scraped_at）
 *
 * 每个源一个适配函数，把各自的字段映射成统一的 TimelineItem。
 * 映射时做了宽松的类型防御：字段缺失或类型不对时给兜底值，不让坏数据炸掉页面。
 */

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict => (v !== null && typeof v === 'object' ? (v as Dict) : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' && v.length > 0 ? v : fallback;
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const toTimestamp = (v: unknown): number => {
  const t = Date.parse(str(v));
  return Number.isNaN(t) ? 0 : t;
};
/** Unix 秒 → 毫秒时间戳（知乎抓取数据的时间字段是秒） */
const toTimestampSeconds = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) : 0;

const AVATAR_COLORS = ['#0084ff', '#ff9607', '#175199', '#eb5f4a', '#00a67e', '#7c4dcc'];

/** 根据名字稳定地取一个头像颜色：同一个作者永远同色 */
export function avatarColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** 知乎条目类型 → 动作文案（类型不再作为标签，见下方 STRUCTURAL_TAGS 说明） */
const ZHIHU_KIND: Record<string, string> = {
  answer: '回答了问题',
  article: '发布了文章',
  question: '提出了问题',
  pin: '发布了想法',
  hot: '登上热榜',
};
const ZHIHU_KIND_FALLBACK = '发布了内容';

/** 源 0：知乎抓取数据（recommend / follow / hot 多个流合并） */
export function normalizeZhihuFeed(raw: unknown): TimelineItem[] {
  const root = asDict(raw);
  const fallbackTs = toTimestamp(root.scraped_at); // 热榜条目没有时间，退化为快照时间
  const feeds = asArray(root.feeds);

  const seen = new Set<string>();
  const items: TimelineItem[] = [];

  for (const feed of feeds) {
    const feedName = str(asDict(feed).source) || undefined; // 子板块：recommend/follow/hot
    for (const entry of asArray(asDict(feed).items)) {
      const it = asDict(entry);
      const rawId = str(it.id);
      if (!rawId || seen.has(rawId)) continue; // 同一条内容可能同时出现在多个流里
      seen.add(rawId);

      const author = asDict(it.author);
      const kind = ZHIHU_KIND[str(it.type)] ?? ZHIHU_KIND_FALLBACK;
      const ts = toTimestampSeconds(it.created_time);
      // AI 生成的分类标签（tagger.mjs 注入）。⚠️ 类型标签（回答/热榜…）故意不追加：
      // 全源同质的标签零区分度，却会污染画像与排序（避雷一条 = 避雷全源、
      // 疲劳/配额全源连坐），详见 scraper/sources.node.mjs 的 STRUCTURAL_TAGS 注释
      const aiTags = asArray(it.tags)
        .map((t) => str(t))
        .filter(Boolean);

      items.push({
        id: `zhihu:${rawId}`,
        source: 'zhihu',
        kind,
        author: str(author.name, '知乎用户'),
        title: str(it.title),
        excerpt: str(it.excerpt),
        createdAt: ts > 0 ? ts : fallbackTs,
        metrics: [
          { label: '赞同', value: num(it.voteup) },
          { label: '评论', value: num(it.comment_count) },
        ],
        tags: aiTags,
        url: str(it.url) || undefined,
        feed: feedName,
      });
    }
  }

  return items;
}

/** B站条目类型 → 动作文案（类型不再作为标签，同知乎） */
const BILI_KIND: Record<string, string> = {
  video: '发布了视频',
  rank: '登上排行榜',
};
const BILI_KIND_FALLBACK = '发布了视频';

/**
 * B站封面图规整：
 *  - http → https（Android 默认禁明文流量，hdslb 图床支持 https）
 *  - 拼官方缩略参数 @480w_270h.webp（bilibili 图床原生支持），省一半以上流量
 */
function normalizeCover(u: string): string {
  const https = u.replace(/^http:\/\//i, 'https://');
  return /^https:\/\/[^/]*hdslb\.com\/.+\.(jpe?g|png|webp)$/i.test(https)
    ? `${https}@480w_270h.webp`
    : https;
}

/** 源 4：B站视频流（popular / rank 流合并），数据结构与知乎抓取同构 */
export function normalizeBilibiliFeed(raw: unknown): TimelineItem[] {
  const root = asDict(raw);
  const fallbackTs = toTimestamp(root.scraped_at);
  const seen = new Set<string>();
  const items: TimelineItem[] = [];

  for (const feed of asArray(root.feeds)) {
    const feedName = str(asDict(feed).source) || undefined; // 子板块：popular/rank/home
    for (const entry of asArray(asDict(feed).items)) {
      const it = asDict(entry);
      const rawId = str(it.id);
      if (!rawId || seen.has(rawId)) continue; // 同一条视频可能同时出现在热门和排行榜
      seen.add(rawId);

      const author = asDict(it.author);
      const kind = BILI_KIND[str(it.type)] ?? BILI_KIND_FALLBACK;
      const ts = toTimestampSeconds(it.created_time);
      // AI 生成的分类标签（tagger.mjs 注入）。类型标签（视频/排行榜）不再追加，
      // 理由同知乎侧（见 normalizeZhihuFeed 内注释）
      const aiTags = asArray(it.tags)
        .map((t) => str(t))
        .filter(Boolean);

      items.push({
        id: `bilibili:${rawId}`,
        source: 'bilibili',
        kind,
        author: str(author.name, 'B站UP主'),
        title: str(it.title),
        excerpt: str(it.excerpt),
        createdAt: ts > 0 ? ts : fallbackTs,
        metrics: [
          { label: '播放', value: num(it.view) },
          { label: '弹幕', value: num(it.danmaku) },
          { label: '点赞', value: num(it.voteup) },
        ],
        tags: aiTags,
        url: str(it.url) || undefined,
        cover: it.pic ? normalizeCover(str(it.pic)) : undefined,
        feed: feedName,
      });
    }
  }

  return items;
}

/** GitHub Trending 周期 → 增量星标的指标标签 */
const GITHUB_PERIOD_LABEL: Record<string, string> = {
  today: '今日',
  'this week': '本周',
  'this month': '本月',
};

/** 源 5：GitHub Trending 榜单（daily/weekly/monthly 流合并），抓取结构与知乎/B站同构 */
export function normalizeGithubFeed(raw: unknown): TimelineItem[] {
  const root = asDict(raw);
  // Trending 页没有时间字段，统一回落到快照时间（榜单每日一更，语义即「今天上榜」）
  const fallbackTs = toTimestamp(root.scraped_at);
  const seen = new Set<string>();
  const items: TimelineItem[] = [];

  for (const feed of asArray(root.feeds)) {
    const feedName = str(asDict(feed).source) || undefined; // 子板块：daily/weekly/monthly
    for (const entry of asArray(asDict(feed).items)) {
      const it = asDict(entry);
      const rawId = str(it.id); // owner/name，同一仓库在多个周期榜重复出现时只取一条
      if (!rawId || seen.has(rawId)) continue;
      seen.add(rawId);

      const author = asDict(it.author);
      const aiTags = asArray(it.tags)
        .map((t) => str(t))
        .filter(Boolean);

      const metrics: Metric[] = [{ label: 'Star', value: num(it.stars) }];
      const periodLabel = GITHUB_PERIOD_LABEL[str(it.period)] ?? '近期';
      const starsPeriod = num(it.stars_period);
      if (starsPeriod > 0) metrics.push({ label: periodLabel, value: starsPeriod });
      metrics.push({ label: 'Fork', value: num(it.forks) });

      items.push({
        id: `github:${rawId}`,
        source: 'github',
        kind: '登上趋势榜',
        author: str(author.name, 'GitHub'),
        title: str(it.title),
        // 卡片内容：LLM 生成的中文介绍（github-summarizer.mjs 注入的 summary）优先，
        // 没有摘要时回落 README 之外的一句话简介
        excerpt: str(it.summary) || str(it.excerpt),
        createdAt: fallbackTs,
        metrics,
        tags: aiTags,
        url: str(it.url) || undefined,
        feed: feedName,
      });
    }
  }

  return items;
}

/** 微博条目类型 → 动作文案（同知乎/B站，类型不作为标签） */
const WEIBO_KIND: Record<string, string> = {
  hot: '登上热搜',
};
const WEIBO_KIND_FALLBACK = '发布了内容';

/** 源 6：微博热搜榜（hot 流），抓取结构与知乎/B站同构 */
export function normalizeWeiboFeed(raw: unknown): TimelineItem[] {
  const root = asDict(raw);
  // 热搜没有时间字段，统一回落到快照时间（每轮抓取刷新，语义即「此刻在榜」）
  const fallbackTs = toTimestamp(root.scraped_at);
  const seen = new Set<string>();
  const items: TimelineItem[] = [];

  for (const feed of asArray(root.feeds)) {
    const feedName = str(asDict(feed).source) || undefined; // 子板块：hot
    for (const entry of asArray(asDict(feed).items)) {
      const it = asDict(entry);
      const rawId = str(it.id); // 热搜词，同词只取一条
      if (!rawId || seen.has(rawId)) continue;
      seen.add(rawId);

      const author = asDict(it.author);
      const kind = WEIBO_KIND[str(it.type)] ?? WEIBO_KIND_FALLBACK;
      const aiTags = asArray(it.tags)
        .map((t) => str(t))
        .filter(Boolean);

      // 指标：热搜标签（热/新/沸/爆…）不是数值，拼进热度指标文案；无热度值时兜底 0
      const heat = num(it.heat);
      const label = str(it.label) || '热度';
      const metrics: Metric[] = [{ label, value: heat }];

      items.push({
        id: `weibo:${rawId}`,
        source: 'weibo',
        kind,
        author: str(author.name, '微博热搜'),
        title: str(it.title),
        excerpt: str(it.excerpt),
        createdAt: fallbackTs,
        metrics,
        tags: aiTags,
        url: str(it.url) || undefined,
        feed: feedName,
      });
    }
  }

  return items;
}

/** 数据源适配器注册表：新增数据源时，在这里加一行即可 */
export const NORMALIZERS: Record<SourceId, (raw: unknown) => TimelineItem[]> = {
  zhihu: normalizeZhihuFeed,
  bilibili: normalizeBilibiliFeed,
  github: normalizeGithubFeed,
  weibo: normalizeWeiboFeed,
};
