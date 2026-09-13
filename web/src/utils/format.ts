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

/** 综合热度：所有指标求和，用于“热门”排序 */
export function hotScore(item: { metrics: { value: number }[] }): number {
  return item.metrics.reduce((sum, m) => sum + m.value, 0);
}
