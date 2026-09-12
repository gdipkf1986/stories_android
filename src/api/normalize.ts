import type { SourceId, TimelineItem } from '../types';

/*
 * 各数据源的 JSON 结构完全不同（与 stories web 端同一套适配逻辑）：
 *  - zhihu-feed.json: { scraped_at, feeds: [{ source, items: [{ id, type, title, excerpt, author: { name }, url, voteup, comment_count, created_time }] }] }
 *  - answers.json:    { items: [{ id, question, author: { name }, excerpt, upvotes, commentCount, answeredAt }] }
 *  - news.json:       { articles: [{ articleId, headline, summary, publisher, publishedAt, readingCount, category }] }
 *  - blogs.json:      [{ slug, title, content, blogger: { nickname }, topics, likes, publishedAt }]
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

/** 知乎条目类型 → 动作文案 + 标签 */
const ZHIHU_KIND: Record<string, { kind: string; tag: string }> = {
  answer: { kind: '回答了问题', tag: '回答' },
  article: { kind: '发布了文章', tag: '文章' },
  question: { kind: '提出了问题', tag: '提问' },
  pin: { kind: '发布了想法', tag: '想法' },
  hot: { kind: '登上热榜', tag: '热榜' },
};
const ZHIHU_KIND_FALLBACK = { kind: '发布了内容', tag: '动态' };

/** 源 0：知乎抓取数据（recommend / follow / hot 多个流合并） */
export function normalizeZhihuFeed(raw: unknown): TimelineItem[] {
  const root = asDict(raw);
  const fallbackTs = toTimestamp(root.scraped_at); // 热榜条目没有时间，退化为快照时间
  const feeds = asArray(root.feeds);

  const seen = new Set<string>();
  const items: TimelineItem[] = [];

  for (const feed of feeds) {
    for (const entry of asArray(asDict(feed).items)) {
      const it = asDict(entry);
      const rawId = str(it.id);
      if (!rawId || seen.has(rawId)) continue; // 同一条内容可能同时出现在多个流里
      seen.add(rawId);

      const author = asDict(it.author);
      const typeMeta = ZHIHU_KIND[str(it.type)] ?? ZHIHU_KIND_FALLBACK;
      const ts = toTimestampSeconds(it.created_time);
      // AI 生成的分类标签（tagger.mjs 注入），缺失时退化为类型标签
      const aiTags = asArray(it.tags)
        .map((t) => str(t))
        .filter(Boolean);

      items.push({
        id: `zhihu:${rawId}`,
        source: 'zhihu',
        kind: typeMeta.kind,
        author: str(author.name, '知乎用户'),
        title: str(it.title),
        excerpt: str(it.excerpt),
        createdAt: ts > 0 ? ts : fallbackTs,
        metrics: [
          { label: '赞同', value: num(it.voteup) },
          { label: '评论', value: num(it.comment_count) },
        ],
        tags: [...new Set([...aiTags, typeMeta.tag])],
        url: str(it.url) || undefined,
      });
    }
  }

  return items;
}

/** 源 1：知乎回答 */
export function normalizeAnswers(raw: unknown): TimelineItem[] {
  return asArray(asDict(raw).items).map((entry) => {
    const it = asDict(entry);
    const author = asDict(it.author);
    return {
      id: `answers:${str(it.id)}`,
      source: 'answers',
      author: str(author.name, '匿名用户'),
      title: str(it.question),
      excerpt: str(it.excerpt),
      createdAt: toTimestamp(it.answeredAt),
      metrics: [
        { label: '赞同', value: num(it.upvotes) },
        { label: '评论', value: num(it.commentCount) },
      ],
      tags: ['回答'],
    };
  });
}

/** 源 2：科技资讯 */
export function normalizeNews(raw: unknown): TimelineItem[] {
  return asArray(asDict(raw).articles).map((entry) => {
    const it = asDict(entry);
    return {
      id: `news:${str(it.articleId)}`,
      source: 'news',
      author: str(it.publisher, '科技早报'),
      title: str(it.headline),
      excerpt: str(it.summary),
      createdAt: toTimestamp(it.publishedAt),
      metrics: [{ label: '阅读', value: num(it.readingCount) }],
      tags: [str(it.category, '资讯')],
    };
  });
}

/** 源 3：博客专栏（注意：顶层直接是数组） */
export function normalizeBlogs(raw: unknown): TimelineItem[] {
  return asArray(raw).map((entry) => {
    const it = asDict(entry);
    const blogger = asDict(it.blogger);
    return {
      id: `blogs:${str(it.slug)}`,
      source: 'blogs',
      author: str(blogger.nickname, '未知作者'),
      title: str(it.title),
      excerpt: str(it.content),
      createdAt: toTimestamp(it.publishedAt),
      metrics: [{ label: '喜欢', value: num(it.likes) }],
      tags: asArray(it.topics).map((t) => str(t, '文章')),
    };
  });
}

/** 数据源适配器注册表：新增数据源时，在这里加一行即可 */
export const NORMALIZERS: Record<SourceId, (raw: unknown) => TimelineItem[]> = {
  zhihu: normalizeZhihuFeed,
  answers: normalizeAnswers,
  news: normalizeNews,
  blogs: normalizeBlogs,
};
