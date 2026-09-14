/**
 * 加权交错排列（weighted fair interleaving）。
 *
 * 解决的问题：各数据源是整批抓取的，条目时间戳扎堆，「最新」流若全局按时间排，
 * 谁刚更新谁就霸屏（清一色知乎 → 清一色 B站）。
 *
 * 算法：把每个源看作一条按自身节奏发条的流，源内第 j 条（0 起，源内最新优先）
 * 的「交错时刻」 = (j + 0.5) / 权重。所有流按交错时刻归并排序：
 * - 权重相同 → 严格交替 A B A B A B……
 * - 权重 2:1 → A B A A B A A B……（权重高的源占比 2/3，且另一源被均匀摊开，不扎堆）
 * - 任何前缀里源 i 的占比都趋近 w_i / Σw，比例全局成立
 * - 源耗尽后其余源继续按节奏补位；单源时退化为普通最新优先
 *
 * O(n log n)，确定性输出，新增数据源无需改动（自动参与交错）。
 */

/** 约束：条目自带 source 与 createdAt（TimelineItem 满足），源内按 createdAt 倒序 */
export function interleaveBySource<T extends { source: string; createdAt: number }>(
  items: T[],
  /** 源 → 权重（>0），未注册的源调用方应回落到 1 */
  weightOf: (source: string) => number,
): T[] {
  // 按源分组（保持输入顺序），各源内部先恢复最新优先
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const list = groups.get(it.source);
    if (list) list.push(it);
    else groups.set(it.source, [it]);
  }

  // 源内第 j 条 → 交错时刻 (j + 0.5) / w；+0.5 避免首条时刻为 0 造成的边界偏置
  const keyed: { item: T; key: number }[] = [];
  for (const [source, list] of groups) {
    const w = weightOf(source);
    const weight = typeof w === 'number' && w > 0 ? w : 1;
    list.sort((a, b) => b.createdAt - a.createdAt);
    list.forEach((item, j) => keyed.push({ item, key: (j + 0.5) / weight }));
  }

  // 按交错时刻升序归并；同刻并列时更晚发布的在前（配合稳定排序，等权重自然严格交替）
  keyed.sort((a, b) => a.key - b.key || b.item.createdAt - a.item.createdAt);
  return keyed.map((k) => k.item);
}
