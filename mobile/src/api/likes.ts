import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Metric, SourceId, TimelineItem } from '../types';

/**
 * 「我喜欢」收藏夹（纯本地，永不过期）：
 *  - 点「♡ 喜欢」的那一刻把整条快照（标题/作者/链接/封面/标签/指标…）存进 AsyncStorage，
 *    而不是只存 itemId 事后回查——服务端时间线 JSON 只留最近几天、事件文件轮转只留 2 片，
 *    旧条目过后无处可查；快照保证收藏条目永远可读、原文链接永远打得开。
 *  - 不设条数上限、不做任何清理（区别于 hidden-items 的 2000 上限）——「永不过期」。
 *  - 列表按点喜欢的时间倒序；同一条重复点喜欢视为重新喜欢（时间置顶）。
 *  - 纯本地、尽力而为：写失败不阻塞 UI（like 事件照常补发），读失败返回空列表。
 *    已知取舍：数据在本机，不跨设备同步，重装 App / 清存储会丢。
 */

/** 收藏条目快照：TimelineItem 里值得长期保留的字段 + likedAt */
export interface LikedItem {
  id: string;
  source: SourceId;
  author: string;
  title: string;
  excerpt: string;
  tags: string[];
  metrics: Metric[];
  /** 原文链接（收藏时快照，可能没有） */
  url?: string;
  /** 封面图（B站视频等，可能没有） */
  cover?: string;
  /** 源内子板块（zhihu:recommend 等，可能没有） */
  feed?: string;
  /** 条目发布时间（原样保留，展示用） */
  createdAt: number;
  /** 点喜欢的时间（毫秒）：排序与展示都以它为准 */
  likedAt: number;
}

const LIKES_KEY = 'stories.likes';

/** 读收藏列表（按喜欢时间倒序）；数据损坏一律按空列表处理，绝不让收藏屏崩掉 */
export async function loadLikedItems(): Promise<LikedItem[]> {
  try {
    const parsed: unknown = JSON.parse((await AsyncStorage.getItem(LIKES_KEY)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const items = parsed.filter(isLikedItem);
    items.sort((a, b) => b.likedAt - a.likedAt); // 存储顺序只是缓存，读出永远重排兜底
    return items;
  } catch {
    return [];
  }
}

/** 收藏一条（点「♡ 喜欢」按钮时调用）：按 id 去重，重复收藏按最新时间置顶 */
export async function saveLikedItem(
  item: TimelineItem,
  likedAt: number = Date.now(),
): Promise<void> {
  try {
    const rest = (await loadLikedItems()).filter((it) => it.id !== item.id);
    await AsyncStorage.setItem(LIKES_KEY, JSON.stringify([toLikedItem(item, likedAt), ...rest]));
  } catch {
    // 尽力而为：存储失败不影响主流程
  }
}

/** 从时间线条目抓一份长期快照（可选字段缺了就不写，别存 undefined 进 JSON） */
function toLikedItem(item: TimelineItem, likedAt: number): LikedItem {
  return {
    id: item.id,
    source: item.source,
    author: item.author,
    title: item.title,
    excerpt: item.excerpt,
    tags: item.tags,
    metrics: item.metrics,
    ...(item.url ? { url: item.url } : {}),
    ...(item.cover ? { cover: item.cover } : {}),
    ...(item.feed ? { feed: item.feed } : {}),
    createdAt: item.createdAt,
    likedAt,
  };
}

/** 宽松校验：四个关键字段在就当有效（老版本数据/手改数据不至于让整屏白屏） */
function isLikedItem(value: unknown): value is LikedItem {
  if (value === null || typeof value !== 'object') return false;
  const it = value as Partial<LikedItem>;
  return (
    typeof it.id === 'string' &&
    typeof it.source === 'string' &&
    typeof it.title === 'string' &&
    typeof it.likedAt === 'number'
  );
}
