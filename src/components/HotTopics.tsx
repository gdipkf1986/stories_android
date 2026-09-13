import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TimelineItem } from '../types';
import { formatCount, hotScore } from '../utils/format';

/**
 * 热门内容榜（移植自 web 端 HotTopics 侧栏）：按热度分（metrics 求和）
 * 取前 5。移动端收进一条可折叠横幅，随列表滚动，不占常驻空间。
 * 纯展示，不可点击（与 web 端一致）。
 */
export default function HotTopics({ items }: { items: TimelineItem[] }) {
  const [open, setOpen] = useState(false);
  const hot = useMemo(
    () => [...items].sort((a, b) => hotScore(b) - hotScore(a)).slice(0, 5),
    [items],
  );

  if (hot.length === 0) return null;

  return (
    <View style={styles.card}>
      <Pressable style={styles.head} onPress={() => setOpen((v) => !v)} hitSlop={4}>
        <Text style={styles.title}>🔥 热门内容</Text>
        <Text style={styles.toggle}>{open ? '收起 ▴' : '展开 ▾'}</Text>
      </Pressable>
      {open &&
        hot.map((item, i) => (
          <View key={item.id} style={styles.row}>
            <Text style={[styles.rank, i < 3 && styles.rankTop]}>{i + 1}</Text>
            <Text style={styles.text} numberOfLines={1}>
              {item.title || item.excerpt || item.author}
            </Text>
            <Text style={styles.score}>{formatCount(hotScore(item))} 热度</Text>
          </View>
        ))}
    </View>
  );
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
