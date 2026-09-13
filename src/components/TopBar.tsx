import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { SOURCES } from '../api/sources';
import type { SortMode, SourceId } from '../types';
import SourceMenu from './SourceMenu';

const SORTS: { id: SortMode; label: string }[] = [
  { id: 'latest', label: '最新' },
  { id: 'hot', label: '热门' },
  { id: 'foryou', label: '为你推荐' },
];

type Props = {
  sort: SortMode;
  onSortChange: (sort: SortMode) => void;
  /** 被隐藏的来源/子板块 key 集合（'zhihu'、'zhihu:hot'、'bilibili:rank'） */
  hiddenKeys: Set<string>;
  /** 切换整个来源的显示/隐藏 */
  onToggleSource: (source: SourceId) => void;
  /** 切换某来源下某子板块的显示/隐藏 */
  onToggleFeed: (source: SourceId, feed: string) => void;
  /** 恢复显示全部（清空隐藏集合） */
  onShowAll: () => void;
  /** 各数据源当前条目数 */
  counts: Map<SourceId, number>;
  /** 各子板块条目数，key 为 `${source}:${feed}` */
  feedCounts: Map<string, number>;
  /** 全部条目数 */
  total: number;
  /** 打开侧滑抽屉菜单（画像 / 关于） */
  onOpenMenu: () => void;
};

/**
 * 顶栏：logo + 排序 + 来源显隐筛选 + 汉堡菜单入口。
 *
 * 筛选是多选显隐模型（不再是单选跳转）：
 *  - 来源按钮主体：点击切换 显示/隐藏 该来源全部内容（隐藏时按钮变灰）
 *  - 按钮尾部的 ▾：打开下拉面板，单独开关该来源的子板块（知乎：推荐/关注/热榜；B站：热门/排行榜）
 *  - 「全部」：一键恢复显示所有来源与子板块
 */
export default function TopBar({
  sort,
  onSortChange,
  hiddenKeys,
  onToggleSource,
  onToggleFeed,
  onShowAll,
  counts,
  feedCounts,
  total,
  onOpenMenu,
}: Props) {
  /** 当前打开下拉面板的来源（null = 都没开） */
  const [menuSource, setMenuSource] = useState<SourceId | null>(null);
  /** chips 行底部在顶栏内的 y 坐标：下拉面板贴着它下方弹出（Modal 无状态栏偏移，坐标同源） */
  const [chipsBottom, setChipsBottom] = useState(0);
  const nothingHidden = hiddenKeys.size === 0;
  const menuMeta = SOURCES.find((s) => s.id === menuSource);

  const handleChipsLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    setChipsBottom(y + height);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.logoRow}>
        <View style={styles.logoMark}>
          <Text style={styles.logoMarkText}>时</Text>
        </View>
        <Text style={styles.logoText}>stories</Text>

        <View style={styles.sortGroup}>
          {SORTS.map((s) => (
            <Pressable
              key={s.id}
              style={[styles.sortBtn, sort === s.id && styles.sortBtnActive]}
              onPress={() => onSortChange(s.id)}
            >
              <Text style={[styles.sortText, sort === s.id && styles.sortTextActive]}>
                {s.label}
              </Text>
            </Pressable>
          ))}
          <Pressable style={styles.menuBtn} onPress={onOpenMenu} hitSlop={6}>
            <Text style={styles.menuText}>☰</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipsScroll}
        contentContainerStyle={styles.chipsContent}
        onLayout={handleChipsLayout}
      >
        <Chip
          label="全部"
          dotColor="#0084ff"
          count={total}
          active={nothingHidden}
          onPress={onShowAll}
        />
        {SOURCES.map((s) => (
          <SourceChip
            key={s.id}
            source={s}
            count={counts.get(s.id) ?? 0}
            hidden={hiddenKeys.has(s.id)}
            hasMenu={(s.feeds?.length ?? 0) > 0}
            menuOpen={menuSource === s.id}
            onToggle={() => onToggleSource(s.id)}
            onOpenMenu={() => setMenuSource(menuSource === s.id ? null : s.id)}
          />
        ))}
      </ScrollView>

      {menuMeta && (
        <SourceMenu
          source={menuMeta}
          panelTop={chipsBottom + 6}
          hiddenKeys={hiddenKeys}
          feedCounts={feedCounts}
          onToggleSource={(id) => onToggleSource(id)}
          onToggleFeed={(id, feed) => onToggleFeed(id, feed)}
          onClose={() => setMenuSource(null)}
        />
      )}
    </View>
  );
}

/** 普通筛选按钮（无子板块的源与「全部」）：点击切换显隐，隐藏时变灰 */
function Chip({
  label,
  dotColor,
  count,
  active,
  onPress,
}: {
  label: string;
  dotColor: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
      {count > 0 && (
        <Text style={[styles.chipCount, active && styles.chipCountActive]}>{count}</Text>
      )}
    </Pressable>
  );
}

/**
 * 带下拉的来源按钮（分体式）：
 *  [● 知乎 42 | ▾] —— 主体点击整源显隐，▾ 打开子板块开关面板；无子板块时退化为普通 Chip。
 */
function SourceChip({
  source,
  count,
  hidden,
  hasMenu,
  menuOpen,
  onToggle,
  onOpenMenu,
}: {
  source: (typeof SOURCES)[number];
  count: number;
  hidden: boolean;
  hasMenu: boolean;
  menuOpen: boolean;
  onToggle: () => void;
  onOpenMenu: () => void;
}) {
  return (
    <View style={[styles.chip, hasMenu && styles.chipSplit, hidden && styles.chipHidden]}>
      <Pressable style={styles.chipMain} onPress={onToggle}>
        <View style={[styles.dot, { backgroundColor: source.color }]} />
        <Text style={[styles.chipText, hidden && styles.chipTextHidden]}>{source.label}</Text>
        {count > 0 && (
          <Text style={[styles.chipCount, hidden && styles.chipCountHidden]}>{count}</Text>
        )}
      </Pressable>
      {hasMenu && (
        <>
          <View style={styles.chipDivider} />
          <Pressable style={styles.chipArrow} onPress={onOpenMenu} hitSlop={6}>
            <Text style={[styles.arrowText, menuOpen && styles.arrowTextActive]}>
              {menuOpen ? '▴' : '▾'}
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 6,
  },
  logoMark: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: '#0084ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoMarkText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  logoText: {
    marginLeft: 8,
    fontSize: 19,
    fontWeight: '700',
    color: '#121212',
  },
  sortGroup: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f2f3f5',
    borderRadius: 16,
    padding: 2,
  },
  menuBtn: {
    paddingHorizontal: 10,
  },
  menuText: {
    fontSize: 18,
    color: '#121212',
    lineHeight: 22,
  },
  sortBtn: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 14,
  },
  sortBtnActive: {
    backgroundColor: '#0084ff',
  },
  sortText: {
    fontSize: 13,
    color: '#8590a6',
    fontWeight: '500',
  },
  sortTextActive: {
    color: '#ffffff',
  },
  chipsScroll: {
    flexGrow: 0,
    marginTop: 10,
  },
  chipsContent: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#dcdfe4',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  chipActive: {
    backgroundColor: '#e8f3ff',
    borderColor: '#0084ff',
  },
  chipSplit: {
    paddingLeft: 12,
    paddingRight: 4,
    gap: 0,
  },
  chipHidden: {
    backgroundColor: '#f5f5f7',
    borderColor: '#e4e6ea',
  },
  chipMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 5,
  },
  chipDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: '#e4e6ea',
    alignSelf: 'stretch',
    marginHorizontal: 6,
    marginVertical: 4,
  },
  chipArrow: {
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  arrowText: {
    fontSize: 12,
    color: '#8590a6',
  },
  arrowTextActive: {
    color: '#0084ff',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  chipText: {
    fontSize: 13,
    color: '#555555',
  },
  chipTextActive: {
    color: '#0084ff',
    fontWeight: '600',
  },
  chipTextHidden: {
    color: '#b9c0cc',
  },
  chipCount: {
    fontSize: 11,
    color: '#a5adbb',
  },
  chipCountActive: {
    color: '#0084ff',
  },
  chipCountHidden: {
    color: '#d3d7de',
  },
});
