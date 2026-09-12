import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TimelineItem } from '../types';
import { sourceMeta } from '../api/sources';
import { avatarColorFor } from '../api/normalize';
import { formatCount, formatRelativeTime } from '../utils/format';
import { openItemUrl } from '../utils/zhihu-app';

/**
 * 单条时间线卡片：归一化后的 TimelineItem 已经足够渲染，不需要关心它来自哪个源。
 * 点卡片任意位置 → 知乎链接优先唤起知乎 App（未装回落系统浏览器），其他链接走浏览器。
 */
function TimelineCard({ item }: { item: TimelineItem }) {
  const meta = sourceMeta(item.source);
  const hasLink = Boolean(item.url);

  const open = () => {
    void openItemUrl(item.url);
  };

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={hasLink ? open : undefined}
      disabled={!hasLink}
      android_ripple={{ color: '#0000000a' }}
    >
      <View style={styles.head}>
        <View style={[styles.avatar, { backgroundColor: avatarColorFor(item.author) }]}>
          <Text style={styles.avatarText}>{item.author.slice(0, 1)}</Text>
        </View>
        <View style={styles.headText}>
          <Text style={styles.author} numberOfLines={1}>
            {item.author}
            <Text style={styles.kind}> {item.kind ?? meta.kind}</Text>
          </Text>
          <Text style={styles.time}>{formatRelativeTime(item.createdAt)}</Text>
        </View>
        <Text style={[styles.badge, { color: meta.color }]}>{meta.label}</Text>
      </View>

      {!!item.title && <Text style={styles.title}>{item.title}</Text>}
      {!!item.excerpt && (
        <Text style={styles.excerpt} numberOfLines={4}>
          {item.excerpt}
        </Text>
      )}

      {item.tags.length > 0 && (
        <View style={styles.tags}>
          {item.tags.map((tag, i) => (
            <View key={`${tag}-${i}`} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.foot}>
        <View style={styles.metrics}>
          {item.metrics.map((m) => (
            <Text key={m.label} style={styles.metric}>
              {m.label} {formatCount(m.value)}
            </Text>
          ))}
        </View>
        {hasLink && <Text style={styles.openLink}>查看原文 ↗</Text>}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    marginHorizontal: 12,
    marginTop: 10,
    padding: 14,
    elevation: 1,
  },
  cardPressed: {
    backgroundColor: '#f7f8fa',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  headText: {
    flex: 1,
    marginHorizontal: 10,
    gap: 2,
  },
  author: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  kind: {
    fontSize: 12,
    fontWeight: '400',
    color: '#8590a6',
  },
  time: {
    fontSize: 12,
    color: '#a5adbb',
  },
  badge: {
    fontSize: 12,
    fontWeight: '600',
  },
  title: {
    marginTop: 10,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    color: '#121212',
  },
  excerpt: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 22,
    color: '#646464',
  },
  tags: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tag: {
    backgroundColor: '#f2f3f5',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: {
    fontSize: 12,
    color: '#8590a6',
  },
  foot: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metrics: {
    flexDirection: 'row',
    gap: 14,
  },
  metric: {
    fontSize: 12,
    color: '#8590a6',
  },
  openLink: {
    fontSize: 12,
    fontWeight: '500',
    color: '#0084ff',
  },
});

export default memo(TimelineCard);
