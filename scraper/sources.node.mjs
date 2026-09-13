/**
 * Node 侧数据源注册表（排序管线专用）。
 *
 * 与前端 src/data/sources.ts + src/data/normalize.ts 对应：
 * 前端负责完整渲染字段，这里只归一化排序需要的最小字段
 * （id / source / tags / title / excerpt / createdAt / author / url）。
 *
 * ⚠️ 新数据源接入要改两处（都只有一行/一个函数）：
 *   1. 前端：src/data/normalize.ts 写适配器 + sources.ts 加元信息（UI 生效）
 *   2. 这里：SOURCES_NODE 加一条 + 写一个轻量适配器（推荐排序生效）
 *
 * id 规则必须与前端一致：`${source}:${原始id}`，否则推荐流无法对上时间线条目。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const PUBLIC_DATA_DIR = path.resolve(import.meta.dirname, '..', 'public', 'data');

/** 知乎条目 type → 结构标签（与前端 ZHIHU_KIND 一致，仅取 tag 部分） */
const ZHIHU_TYPE_TAG = {
  answer: '回答',
  article: '文章',
  question: '提问',
  pin: '想法',
  hot: '热榜',
};

/** B站条目 type → 结构标签（与前端 BILI_KIND 一致，仅取 tag 部分） */
const BILI_TYPE_TAG = {
  video: '视频',
  rank: '排行榜',
};

const asArray = (v) => (Array.isArray(v) ? v : []);
const asDict = (v) => (v !== null && typeof v === 'object' ? v : {});
const str = (v, fallback = '') => (typeof v === 'string' && v.length > 0 ? v : fallback);
const numMs = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 1000); // Unix 秒
  const t = Date.parse(String(v ?? ''));
  return Number.isNaN(t) ? 0 : t;
};
const cleanTags = (arr, limit = 8) =>
  [...new Set(asArray(arr).map((t) => String(t ?? '').trim()).filter((t) => t.length > 0 && t.length <= 24))].slice(0, limit);

/**
 * 源注册表。file 相对 public/data/；每个源一个 adapt(raw) 返回轻量条目数组。
 * 未打 AI 标签的源（answers/news/blogs 目前是静态粗标签）排序权重自然偏低，
 * 后续把 tagger 扩展到这些源即可自动变准——管线本身不用改。
 */
export const SOURCES_NODE = [
  {
    id: 'zhihu',
    file: 'zhihu-feed.json',
    adapt(raw) {
      const root = asDict(raw);
      const fallbackTs = Date.parse(str(root.scraped_at)) || 0;
      const out = [];
      const seen = new Set();
      for (const feed of asArray(root.feeds)) {
        for (const entry of asArray(asDict(feed).items)) {
          const it = asDict(entry);
          const rawId = str(it.id);
          if (!rawId || seen.has(rawId)) continue;
          seen.add(rawId);
          const typeTag = ZHIHU_TYPE_TAG[str(it.type)] ?? '动态';
          const aiTags = cleanTags(it.tags);
          out.push({
            id: `zhihu:${rawId}`,
            source: 'zhihu',
            title: str(it.title).slice(0, 200),
            excerpt: str(it.excerpt).slice(0, 300),
            author: str(asDict(it.author).name, '知乎用户'),
            createdAt: numMs(it.created_time) || fallbackTs,
            url: str(it.url) || undefined,
            // 与前端一致：AI 标签 + 结构标签
            tags: [...aiTags, typeTag],
          });
        }
      }
      return out;
    },
  },
  {
    id: 'bilibili',
    file: 'bilibili-feed.json',
    adapt(raw) {
      const root = asDict(raw);
      const fallbackTs = Date.parse(str(root.scraped_at)) || 0;
      const out = [];
      const seen = new Set();
      for (const feed of asArray(root.feeds)) {
        for (const entry of asArray(asDict(feed).items)) {
          const it = asDict(entry);
          const rawId = str(it.id);
          if (!rawId || seen.has(rawId)) continue;
          seen.add(rawId);
          const typeTag = BILI_TYPE_TAG[str(it.type)] ?? '视频';
          const aiTags = cleanTags(it.tags);
          out.push({
            id: `bilibili:${rawId}`,
            source: 'bilibili',
            title: str(it.title).slice(0, 200),
            excerpt: str(it.excerpt).slice(0, 300),
            author: str(asDict(it.author).name, 'B站UP主'),
            createdAt: numMs(it.created_time) || fallbackTs,
            url: str(it.url) || undefined,
            // 与前端一致：AI 标签 + 结构标签
            tags: [...aiTags, typeTag],
          });
        }
      }
      return out;
    },
  },
  {
    id: 'answers',
    file: 'answers.json',
    adapt(raw) {
      return asArray(asDict(raw).items).map((entry) => {
        const it = asDict(entry);
        return {
          id: `answers:${str(it.id)}`,
          source: 'answers',
          title: str(it.question).slice(0, 200),
          excerpt: str(it.excerpt).slice(0, 300),
          author: str(asDict(it.author).name, '匿名用户'),
          createdAt: Date.parse(str(it.answeredAt)) || 0,
          url: undefined,
          tags: ['回答'],
        };
      });
    },
  },
  {
    id: 'news',
    file: 'news.json',
    adapt(raw) {
      return asArray(asDict(raw).articles).map((entry) => {
        const it = asDict(entry);
        return {
          id: `news:${str(it.articleId)}`,
          source: 'news',
          title: str(it.headline).slice(0, 200),
          excerpt: str(it.summary).slice(0, 300),
          author: str(it.publisher, '科技早报'),
          createdAt: Date.parse(str(it.publishedAt)) || 0,
          url: undefined,
          tags: cleanTags([str(it.category, '资讯')]),
        };
      });
    },
  },
  {
    id: 'blogs',
    file: 'blogs.json',
    adapt(raw) {
      return asArray(raw).map((entry) => {
        const it = asDict(entry);
        return {
          id: `blogs:${str(it.slug)}`,
          source: 'blogs',
          title: str(it.title).slice(0, 200),
          excerpt: str(it.content).slice(0, 300),
          author: str(asDict(it.blogger).nickname, '未知作者'),
          createdAt: Date.parse(str(it.publishedAt)) || 0,
          url: undefined,
          tags: cleanTags(it.topics).length > 0 ? cleanTags(it.topics) : ['文章'],
        };
      });
    },
  },
];

/**
 * 并发读取所有源 → 归一化。单源文件缺失/损坏只记 warning，不拖垮整体。
 * 返回 { items, failures }（与前端 loadTimeline 的容错语义一致）。
 */
export async function loadAllSources() {
  const settled = await Promise.allSettled(
    SOURCES_NODE.map(async (source) => {
      const raw = JSON.parse(await readFile(path.join(PUBLIC_DATA_DIR, source.file), 'utf8'));
      return source.adapt(raw);
    }),
  );
  const items = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else failures.push({ source: SOURCES_NODE[i].id, reason: String(r.reason?.message ?? r.reason) });
  });
  return { items, failures };
}

/** 便于调试：node scraper/sources.node.mjs 直接打印各源条数 */
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  loadAllSources().then(({ items, failures }) => {
    const bySource = {};
    for (const it of items) bySource[it.source] = (bySource[it.source] ?? 0) + 1;
    console.log('各源条数:', bySource);
    if (failures.length > 0) console.warn('失败源:', failures);
  });
}
