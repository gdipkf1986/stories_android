import { memo, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TimelineItem } from '../../types';
import { openItemUrl } from '../../utils/zhihu-app';
import { resolveCardModel, type CardModel } from './cardModel';

/**
 * FeedCard —— 全项目唯一的条目卡片组件。
 *
 * 任何数据源（知乎/B站/未来新源）的任何子板块，条目一律由它渲染：
 * 归一化后的 TimelineItem 经 cardModel.resolveCardModel 解析成视图模型，
 * 本组件只负责照模型画，不出现任何 `item.source === 'xxx'` 的分支。
 * 各源/各子板块的长相差异只允许通过 sources.ts 注册表的 card: CardVisual 微调；
 * 需要新的展示形态时先改 cardModel（两端镜像同步），而不是另写卡片。
 *
 * 交互约定（沿用原信息流卡片的行为）：
 *  - 点卡片任意位置 → 打开原文：知乎链接优先唤起知乎 App、B站链接优先唤起 B站 App
 *    （未装回落系统浏览器，见 utils/zhihu-app.ts）；点开原文等价于点了喜欢，由
 *    onOpened 通知上层（记喜欢 + 信息流隐藏）。
 *  - 底部「喜欢 / 不感兴趣」按钮 → 手动反馈（同样会从信息流隐藏这条）。
 *  - 内层 Pressable 接管触摸，点按钮不会触发卡片的打开行为。
 */
function FeedCard({
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
  // item 不变则模型不变；解析出「画什么」，本组件只管「怎么画」
  const model: CardModel = useMemo(
    () => resolveCardModel(item, { reason, explore }),
    [item, reason, explore],
  );
  /** 封面加载失败 → 隐藏图，退化为纯文字卡片 */
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = Boolean(model.cover) && !coverFailed;
  const rec = model.recommendation;

  const open = () => {
    onOpened?.(item);
    void openItemUrl(item.url);
  };

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={model.openable ? open : undefined}
      disabled={!model.openable}
      android_ripple={{ color: '#0000000a' }}
    >
      <View style={styles.head}>
        <View style={[styles.avatar, { backgroundColor: model.author.color }]}>
          <Text style={styles.avatarText}>{model.author.initial}</Text>
        </View>
        <View style={styles.headText}>
          <Text style={styles.author} numberOfLines={1}>
            {model.author.name}
            <Text style={styles.kind}> {model.kindText}</Text>
          </Text>
          <Text style={styles.time}>{model.timeText}</Text>
        </View>
        <Text style={[styles.badge, { color: model.badge.color }]}>{model.badge.label}</Text>
      </View>

      {showCover && model.cover && (
        <Image
          source={{ uri: model.cover.uri }}
          style={[styles.cover, { aspectRatio: model.cover.aspect }]}
          resizeMode="cover"
          onError={() => setCoverFailed(true)}
        />
      )}

      {!!model.title && (
        <Text style={[styles.title, showCover && styles.titleAfterCover]}>{model.title}</Text>
      )}
      {model.excerpt !== null && (
        <Text style={styles.excerpt} numberOfLines={4}>
          {model.excerpt}
        </Text>
      )}

      {rec && (
        <View style={styles.reasonRow}>
          {rec.explore && <Text style={styles.reasonExplore}>探索</Text>}
          {rec.reason && <Text style={styles.reasonText}>{rec.reason}</Text>}
        </View>
      )}

      {model.tags.length > 0 && (
        <View style={styles.tags}>
          {model.tags.map((tag, i) => (
            <View key={`${tag}-${i}`} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.foot}>
        <View style={styles.metrics}>
          {model.metrics.map((m) => (
            <Text key={m.label} style={styles.metric}>
              {m.label} {m.value}
            </Text>
          ))}
        </View>
        {model.openable && <Text style={styles.openLink}>查看原文 ↗</Text>}
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
    // 通到卡片边缘的封面图（抵消卡片内边距），宽高比由该数据源的 CardVisual 决定
    alignSelf: 'stretch',
    marginHorizontal: -14,
    marginTop: -14,
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

export default memo(FeedCard);
