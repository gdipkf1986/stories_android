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
 *    onOpened 通知上层（记喜欢 + 持久隐藏名单），并且卡片就地折叠成灰底标题条
 *    （opened=true），不立即从信息流消失，刷新/重启后才不再出现。
 *  - 站内阅读条目（expandable：有全文译文 contentZh，或 HN 条目 inAppRead）例外：
 *    点卡片是「展开/收起」阅读区，不记喜欢、不隐藏、不跳原文。
 *    · 已有译文（contentZh）：直接渲染全文；
 *    · 还没翻（HN 默认只有中文摘要，全文翻译按需省 token）：展开区给「翻译全文」
 *      按钮 → 调 POST /api/hn/translate 现翻（服务端缓存，首次约半分钟），翻完就地渲染。
 *    读完想看原文再点译文末尾的「阅读原文」，那一步才走 onOpened + openItemUrl。
 *  - 底部「喜欢 / 不感兴趣」按钮 → 手动反馈（立即从信息流移除这条）。
 *  - 内层 Pressable 接管触摸，点按钮不会触发卡片的打开行为。
 */
import { memo, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TimelineItem } from '../../types';
import { openItemUrl } from '../../utils/zhihu-app';
import { translateHnArticle } from '../../api/translate';
import { resolveCardModel, type CardModel } from './cardModel';

function FeedCard({
  item,
  onOpened,
  onLike,
  onDislike,
  reason,
  explore,
  opened,
}: {
  item: TimelineItem;
  onOpened?: (item: TimelineItem) => void;
  onLike?: (item: TimelineItem) => void;
  onDislike?: (item: TimelineItem) => void;
  /** 「为你推荐」排序下的推荐理由（ranker 模板生成），缺省不显示 */
  reason?: string;
  /** 探索位标记（画像里没见过的方向），显示一个小徽标 */
  explore?: boolean;
  /** 点开过的条目：就地折叠成灰底标题条（仍可点击再次打开），不再整卡消失 */
  opened?: boolean;
}) {
  // item 不变则模型不变；解析出「画什么」，本组件只管「怎么画」
  const model: CardModel = useMemo(
    () => resolveCardModel(item, { reason, explore }),
    [item, reason, explore],
  );
  /** 封面加载失败 → 隐藏图，退化为纯文字卡片 */
  const [coverFailed, setCoverFailed] = useState(false);
  /** 阅读区展开态（仅 model.expandable 时有意义） */
  const [expanded, setExpanded] = useState(false);
  /** 点击「翻译全文」后取回的译文（与 model.contentZh 二选一，现取的优先级低） */
  const [translatedZh, setTranslatedZh] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateFailed, setTranslateFailed] = useState(false);
  const showCover = Boolean(model.cover) && !coverFailed;
  const rec = model.recommendation;

  /** 打开原文：记喜欢 + 持久隐藏 + 深链/浏览器跳转 */
  const openOriginal = () => {
    onOpened?.(item);
    void openItemUrl(item.url);
  };

  /** 按需全文翻译：服务端有缓存秒回，没缓存现翻（约半分钟），失败可点重试 */
  const translate = () => {
    if (translating || translatedZh !== null) return;
    setTranslating(true);
    setTranslateFailed(false);
    translateHnArticle(item.id)
      .then(setTranslatedZh)
      .catch(() => setTranslateFailed(true))
      .finally(() => setTranslating(false));
  };

  const open = () => {
    // 站内阅读条目（有译文或可翻译的 HN 条目）：点击 = 展开/收起阅读区（不记反馈、不跳原文）
    if (model.expandable) {
      setExpanded((e) => !e);
      return;
    }
    openOriginal();
  };

  // 已点开：折叠态——只保留标题，内容/指标/操作全部收起，灰底示意「读过」
  if (opened) {
    return (
      <Pressable
        style={({ pressed }) => [styles.cardCollapsed, pressed && styles.cardCollapsedPressed]}
        onPress={model.openable ? (model.expandable ? openOriginal : open) : undefined}
        disabled={!model.openable}
        android_ripple={{ color: '#0000000a' }}
      >
        <Text style={styles.collapsedTitle} numberOfLines={2}>
          {item.title}
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={model.openable ? open : undefined}
      disabled={!model.openable}
      android_ripple={{ color: '#0000000a' }}
    >
      {showCover && model.cover && (
        <Image
          source={{ uri: model.cover.uri }}
          style={[styles.cover, { aspectRatio: model.cover.aspect }]}
          resizeMode="cover"
          onError={() => setCoverFailed(true)}
        />
      )}

      <View style={[styles.head, showCover && styles.headAfterCover]}>
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

      {!!model.title && (
        <Text style={[styles.title, showCover && styles.titleAfterCover]}>{model.title}</Text>
      )}
      {model.excerpt !== null && !expanded && (
        <Text style={styles.excerpt} numberOfLines={4}>
          {model.excerpt}
        </Text>
      )}

      {expanded && model.expandable && (
        <View style={styles.article}>
          {(() => {
            const zh = model.contentZh ?? translatedZh;
            if (zh !== null) {
              return <Text style={styles.articleText}>{zh}</Text>;
            }
            // 还没翻：给「翻译全文」按钮（HN 默认只翻标题+摘要，全文按需省 token）
            return (
              <Pressable
                style={({ pressed }) => [styles.translateBtn, pressed && styles.translateBtnPressed]}
                onPress={translate}
                disabled={translating}
                android_ripple={{ color: '#0000000a' }}
              >
                <Text style={styles.translateBtnText}>
                  {translating ? '翻译中…（首次约1分钟）' : translateFailed ? '翻译失败，点此重试' : '翻译全文'}
                </Text>
              </Pressable>
            );
          })()}
          {model.openable && (
            <Pressable
              style={({ pressed }) => [styles.articleLink, pressed && styles.articleLinkPressed]}
              onPress={openOriginal}
              android_ripple={{ color: '#0000000a' }}
            >
              <Text style={styles.openLink}>阅读原文 ↗</Text>
            </Pressable>
          )}
        </View>
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
        {model.openable && (
          <Text style={styles.openLink}>
            {model.expandable
              ? expanded
                ? '收起 ▴'
                : model.contentZh
                  ? '展开译文 ▾'
                  : '展开阅读 ▾'
              : '查看原文 ↗'}
          </Text>
        )}
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
  cardCollapsed: {
    backgroundColor: '#e9eaec', // 灰底：与白卡和页面底色都拉开层次，示意「已读过」
    borderRadius: 12,
    marginHorizontal: 12,
    marginTop: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  cardCollapsedPressed: {
    backgroundColor: '#e0e2e5',
  },
  collapsedTitle: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '500',
    color: '#646464',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headAfterCover: {
    // 封面通到卡片顶边后，头像行跟在图下（卡片内边距只作用于容器边缘，需自己留间距）
    marginTop: 12,
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
  article: {
    marginTop: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#e3e6ea',
    paddingLeft: 10,
  },
  articleText: {
    fontSize: 14,
    lineHeight: 23,
    color: '#333333',
  },
  articleLink: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingRight: 8,
  },
  articleLinkPressed: {
    opacity: 0.6,
  },
  translateBtn: {
    alignSelf: 'flex-start',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#0084ff55',
    backgroundColor: '#f0f7ff',
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  translateBtnPressed: {
    backgroundColor: '#dcebfd',
  },
  translateBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#0084ff',
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
