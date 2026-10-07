import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const PUBLIC_DATA_DIR = process.env.PUBLIC_DATA_DIR
  ?? path.resolve(import.meta.dirname, '..', 'public', 'data');

export const SOURCE_META = [
  {
    id: 'zhihu', file: 'zhihu-feed.json', label: '知乎', kind: '发布了内容',
    color: '#eb5f4a', weight: 1,
    feeds: [
      { id: 'recommend', label: '推荐' },
      { id: 'follow', label: '关注' },
      { id: 'hot', label: '热榜' },
    ],
  },
  {
    id: 'bilibili', file: 'bilibili-feed.json', label: 'B站', kind: '发布了视频',
    color: '#fb7299', weight: 1,
    feeds: [
      { id: 'home', label: '推荐' },
      { id: 'popular', label: '热门' },
      { id: 'rank', label: '排行榜' },
    ],
    card: { coverAspect: 16 / 9 },
  },
  {
    id: 'github', file: 'github-feed.json', label: 'GitHub', kind: '登上趋势榜',
    color: '#1f6feb', weight: 1,
    feeds: [{ id: 'daily', label: '日榜' }],
  },
  {
    id: 'weibo', file: 'weibo-feed.json', label: '微博', kind: '登上热搜',
    color: '#e6162d', weight: 1,
    feeds: [{ id: 'hot', label: '热搜' }],
  },
  {
    id: 'hn', file: 'hn-feed.json', label: 'Hacker News', kind: '登上热榜',
    color: '#ff6600', weight: 1,
    feeds: [
      { id: 'top', label: '热榜' },
      { id: 'best', label: '最佳' },
    ],
  },
  {
    id: 'ifanr', file: 'ifanr-feed.json', label: '爱范儿', kind: '发布了文章',
    color: '#00b389', weight: 1,
    feeds: [{ id: 'latest', label: '最新' }],
  },
];

function feedCount(raw) {
  if (!raw || typeof raw !== 'object') return 0;
  return (raw.feeds ?? []).reduce((sum, feed) => sum + (feed.items?.length ?? 0), 0);
}

export async function loadSourceManifest() {
  const sources = [];
  for (const source of SOURCE_META) {
    try {
      const raw = JSON.parse(await readFile(path.join(PUBLIC_DATA_DIR, source.file), 'utf8'));
      const itemCount = feedCount(raw);
      if (itemCount > 0) sources.push({ ...source, available: true, itemCount });
    } catch {
      // 没有可用快照的源不下发，App 保持旧列表也能正常加载
    }
  }
  return { version: 1, generatedAt: new Date().toISOString(), sources };
}
