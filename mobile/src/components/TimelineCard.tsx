import { memo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TimelineItem } from '../types';
import { sourceMeta } from '../api/sources';
import { avatarColorFor } from '../api/normalize';
import { formatCount, formatRelativeTime } from '../utils/format';
import { openItemUrl } from '../utils/zhihu-app';

/**
 * 单条时间线卡片：归一化后的 TimelineItem 已经足够渲染，不需要关心它来自哪个源。
 * 点卡片任意位置 → 知乎链接优先唤起知乎 App（未装回落系统浏览器），其他链接走浏览器。
 * 点开原文等价于点了喜欢：由 onOpened 通知上层（记喜欢 + 信息流隐藏）。
 * 底部「喜欢 / 不感兴趣」按钮：手动反馈（同样会从信息流隐藏这条）。
 * 内层 Pressable 会接管触摸，点按钮不会触发卡片的打开行为。
 */
function TimelineCard({
  item,
  onOpened,
  onLike,
  onDislike,
  reason,
  explore,
}: {
  item: TimelineItem;
  onOpened?: (item: TimelineItem) => void;
  onLike?: (item: TimelineItem) => void;
  onDislike?: (item: TimelineItem) => void;
  /** 「为你推荐」排序下的推荐理由（ranker 模板生成），缺省不显示 */
  reason?: string;
  /** 探索位标记（画像里没见过的方向），显示一个小徽标 */
  explore?: boolean;
}) {
  const meta = sourceMeta(item.source);
  const hasLink = Boolean(item.url);
  /** 封面加载失败 → 隐藏图，退化为纯文字卡片 */
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = Boolean(item.cover) && !coverFailed;
  // B站抓取的摘要常与标题相同：有封面时重复展示很啰嗦，去重跳过
  const showExcerpt =
    !!item.excerpt && !(showCover && item.excerpt.trim() === item.title.trim());

  const open = () => {
    onOpened?.(item);
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

      {showCover && (
        <Image
          source={{ uri: item.cover }}
          style={styles.cover}
          resizeMode="cover"
          onError={() => setCoverFailed(true)}
        />
      )}

      {!!item.title && (
        <Text style={[styles.title, showCover && styles.titleAfterCover]}>{item.title}</Text>
      )}
      {showExcerpt && (
        <Text style={styles.excerpt} numberOfLines={4}>
          {item.excerpt}
        </Text>
      )}

      {(!!reason || explore) && (
        <View style={styles.reasonRow}>
          {explore && <Text style={styles.reasonExplore}>探索</Text>}
          {!!reason && <Text style={styles.reasonText}>{reason}</Text>}
        </View>
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

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
          onPress={() => onLike?.(item)}
          android_ripple={{ color: '#0000000a', borderless: false }}
        >
          <Text style={[styles.actionText, { color: '#0084ff' }]}>♡ 喜欢</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, pressed && styles.actionBtnPressed]}
          onPress={() => onDislike?.(item)}
          android_ripple={{ color: '#0000000a', borderless: false }}
        >
          <Text style={[styles.actionText, { color: '#8590a6' }]}>✕ 不感兴趣</Text>
        </Pressable>
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
  cover: {
    // 通到卡片边缘的封面图（抵消卡片内边距），B站封面标准 16:9
    alignSelf: 'stretch',
    marginHorizontal: -14,
    marginTop: -14,
    aspectRatio: 16 / 9,
    backgroundColor: '#f2f3f5',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  title: {
    marginTop: 10,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '600',
    color: '#121212',
  },
  titleAfterCover: {
    marginTop: 12,
  },
  excerpt: {
    marginTop: 6,
    fontSize: 14,
    lineHeight: 22,
    color: '#646464',
  },
  reasonRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  reasonExplore: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ad6800',
    backgroundColor: '#fff7e6',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  reasonText: {
    flexShrink: 1,
    fontSize: 12,
    color: '#8590a6',
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
  actions: {
    marginTop: 12,
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#dcdfe4',
    backgroundColor: '#f7f8fa',
  },
  actionBtnPressed: {
    backgroundColor: '#eceef1',
  },
  actionText: {
    fontSize: 13,
    fontWeight: '500',
  },
});

export default memo(TimelineCard);
