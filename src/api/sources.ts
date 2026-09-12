import type {
  SourceId,
  SourceMeta,
  TimelineItem,
  TimelineLoadResult,
} from '../types';
import { NORMALIZERS } from './normalize';
import { API_BASE } from './config';
import { getToken } from './auth';

/**
 * 所有数据源的注册表（与 stories web 端一致）。
 * 要接入新数据源：后端 public/data/ 放 JSON → normalize.ts 写适配器 → 这里加一条。
 */
export const SOURCES: SourceMeta[] = [
  {
    id: 'zhihu',
    label: '知乎推荐流',
    kind: '发布了内容',
    color: '#eb5f4a',
    file: '/data/zhihu-feed.json',
  },
  {
    id: 'answers',
    label: '知乎回答',
    kind: '发布了回答',
    color: '#0084ff',
    file: '/data/answers.json',
  },
  {
    id: 'news',
    label: '科技资讯',
    kind: '发布了资讯',
    color: '#ff9607',
    file: '/data/news.json',
  },
  {
    id: 'blogs',
    label: '博客专栏',
    kind: '发表了文章',
    color: '#175199',
    file: '/data/blogs.json',
  },
];

/**
 * 并发加载所有数据源 → 各自归一化 → 合并 → 按时间倒序。
 * 用 Promise.allSettled 保证单个源加载失败不影响其他源，
 * 失败信息收集起来，由 UI 提示。
 * 已保存 JWT 时自动附加 Authorization: Bearer；任一源返回 401 → unauthorized=true（触发登录页）。
 */
export async function loadTimeline(): Promise<TimelineLoadResult> {
  const token = await getToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const settled = await Promise.allSettled(
    SOURCES.map(async (source) => {
      const res = await fetch(`${API_BASE}${source.file}`, { headers });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const raw: unknown = await res.json();
      return NORMALIZERS[source.id](raw);
    }),
  );

  const items: TimelineItem[] = [];
  const failures: TimelineLoadResult['failures'] = [];
  let unauthorized = false;

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      const source = SOURCES[i];
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push({ source: source.id, reason });
      if ((result.reason as { status?: number })?.status === 401) {
        unauthorized = true;
      }
    }
  });

  items.sort((a, b) => b.createdAt - a.createdAt);
  return { items, failures, unauthorized };
}

/** 按 id 取数据源元信息 */
export function sourceMeta(id: SourceId): SourceMeta {
  return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
}
