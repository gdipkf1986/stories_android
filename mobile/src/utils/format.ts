/** 数字格式化：12893 -> 1.3万，像知乎那样 */
export function formatCount(n: number): string {
  if (n >= 10000) {
    const w = n / 10000;
    const rounded = w >= 100 ? Math.round(w) : Math.round(w * 10) / 10;
    return `${rounded}万`;
  }
  return String(n);
}

/** 相对时间：刚刚 / x分钟前 / x小时前 / x天前 / 具体日期 */
export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '未知时间';
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;

  const d = new Date(timestamp);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 字节数格式化：1536 -> 1.5 KB，用于 APK 下载大小显示 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/** 综合热度：所有指标求和，用于“热门”排序 */
export function hotScore(item: { metrics: { value: number }[] }): number {
  return item.metrics.reduce((sum, m) => sum + m.value, 0);
}

/**
 * 源内热度百分位：把每个源内部的原始热度转成 0~1 的组内排名（组内第 1 名 = 1）。
 *
 * 为什么不直接用原始热度跨源排序：B站播放（几十万）和知乎赞同（几千）量纲差
 * 太大，直接求和会让「热门」排序和热门榜被单一来源刷屏。归一化后每个源的
 * 最热内容都平权进入前排，时间线自然按源交错。
 *
 * 返回 Map<条目id, 百分位>；传入的列表通常是当前可见条目（筛选后重算，
 * 相对排名不受隐藏影响）。
 */
export function computeHotPercentiles(
  items: { id: string; source: string; metrics: { value: number }[] }[],
): Map<string, number> {
  const bySource = new Map<string, { id: string; score: number }[]>();
  for (const it of items) {
    const group = bySource.get(it.source) ?? [];
    group.push({ id: it.id, score: hotScore(it) });
    bySource.set(it.source, group);
  }
  const out = new Map<string, number>();
  for (const group of bySource.values()) {
    group.sort((a, b) => b.score - a.score);
    group.forEach((g, i) => out.set(g.id, (group.length - i) / group.length));
  }
  return out;
}
