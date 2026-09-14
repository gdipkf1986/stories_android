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
 * 要接入新数据源：后端 public/data/ 放 JSON → 这里加一条 → 前端 sources.ts/normalize.ts 镜像同步。
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
          const aiTags = cleanTags(it.tags);
          out.push({
            id: `zhihu:${rawId}`,
            source: 'zhihu',
            title: str(it.title).slice(0, 200),
            excerpt: str(it.excerpt).slice(0, 300),
            author: str(asDict(it.author).name, '知乎用户'),
            createdAt: numMs(it.created_time) || fallbackTs,
            url: str(it.url) || undefined,
            // 只放 AI 内容标签。类型标签（回答/热榜…）不再追加——全源同质的标签
            // 零区分度，却会污染画像与排序（见 STRUCTURAL_TAGS 注释的历史事故）
            tags: aiTags,
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
          const aiTags = cleanTags(it.tags);
          out.push({
            id: `bilibili:${rawId}`,
            source: 'bilibili',
            title: str(it.title).slice(0, 200),
            excerpt: str(it.excerpt).slice(0, 300),
            author: str(asDict(it.author).name, 'B站UP主'),
            createdAt: numMs(it.created_time) || fallbackTs,
            url: str(it.url) || undefined,
            // 同知乎侧：只放 AI 内容标签，不追加类型标签
            tags: aiTags,
          });
        }
      }
      return out;
    },
  },
];

/**
 * 结构标签集合：type 映射出的类型标签 + 兜底标签（动态/视频）。
 * 它们只表达「内容形态/来源子板块」，不表达内容主题；避雷与画像负反馈
 * 必须跳过它们——否则避雷一条 B站视频会记避雷「视频」，把整个 B站源
 * 全部条目排除出推荐流（实际发生过）。
 */
export const STRUCTURAL_TAGS = new Set([
  ...Object.values(ZHIHU_TYPE_TAG),
  ...Object.values(BILI_TYPE_TAG),
  '动态', // zhihu 未识别类型的兜底
]);

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
