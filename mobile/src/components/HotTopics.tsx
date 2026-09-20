import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TimelineItem } from '../types';
import { formatCount, computeHotPercentiles, hotScore } from '../utils/format';

/**
 * 热门内容榜（移植自 web 端 HotTopics 侧栏）：按源内热度百分位取前 5，
 * 各源最热内容平权交错，不被大数值指标（B站播放）单一刷屏。
 * 分数列显示条目最主要指标（如「88万播放」「2998赞同」）——
 * 排序已按组内排名跨源归一，原始总量跨源没有可比性，展示出来只会误导。
 * 榜单行可点击：点行 = 点开该条原文，交给 onOpenItem 处理（上层走与卡片同一条
 * 深链路径 + 记行为反馈）；不传 onOpenItem 或该条没有 url 时退化为纯展示
 * （web 端侧栏就是纯展示，这是移动端有意加的分歧）。
 */
export default function HotTopics({
  items,
  onOpenItem,
}: {
  items: TimelineItem[];
  /** 点榜单某行：上层负责打开原文（深链/浏览器）+ 记点开反馈 */
  onOpenItem?: (item: TimelineItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const hot = useMemo(() => {
    const pct = computeHotPercentiles(items);
    return [...items]
      .sort(
        (a, b) =>
          (pct.get(b.id) ?? 0) - (pct.get(a.id) ?? 0) || hotScore(b) - hotScore(a),
      )
      .slice(0, 5);
  }, [items]);

  if (hot.length === 0) return null;

  return (
    <View style={styles.card}>
      <Pressable style={styles.head} onPress={() => setOpen((v) => !v)} hitSlop={4}>
        <Text style={styles.title}>🔥 热门内容</Text>
        <Text style={styles.toggle}>{open ? '收起 ▴' : '展开 ▾'}</Text>
      </Pressable>
      {open &&
        hot.map((item, i) => (
          <Pressable
            key={item.id}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={item.url && onOpenItem ? () => onOpenItem(item) : undefined}
            disabled={!item.url || !onOpenItem}
            android_ripple={{ color: '#0000000a' }}
          >
            <Text style={[styles.rank, i < 3 && styles.rankTop]}>{i + 1}</Text>
            <Text style={styles.text} numberOfLines={1}>
              {item.title || item.excerpt || item.author}
            </Text>
            <Text style={styles.score}>{topMetricText(item)}</Text>
          </Pressable>
        ))}
    </View>
  );
}

/** 最主要指标：数值最大的那个，显示成「88万播放」「2998赞同」这类可读格式 */
function topMetricText(item: TimelineItem): string {
  const top = item.metrics.reduce<{ label: string; value: number } | null>(
    (best, m) => (best === null || m.value > best.value ? m : best),
    null,
  );
  return top && top.value > 0 ? `${formatCount(top.value)}${top.label}` : '';
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    marginHorizontal: 12,
    marginTop: 10,
    paddingVertical: 4,
    paddingHorizontal: 14,
    elevation: 1,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#121212',
  },
  toggle: {
    fontSize: 12,
    color: '#8590a6',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f0f0f0',
    gap: 8,
  },
  rowPressed: {
    backgroundColor: '#f7f8fa',
  },
  rank: {
    width: 18,
    fontSize: 13,
    fontWeight: '700',
    color: '#a5adbb',
    textAlign: 'center',
  },
  rankTop: {
    color: '#ff9607',
  },
  text: {
    flex: 1,
    fontSize: 13,
    color: '#464646',
  },
  score: {
    fontSize: 11,
    color: '#a5adbb',
  },
});
