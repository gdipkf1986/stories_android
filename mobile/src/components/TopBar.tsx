import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { SOURCES } from '../api/sources';
import type { SortMode, SourceId } from '../types';
import SourceMenu, { type MenuRow } from './SourceMenu';

const SORTS: { id: SortMode; label: string }[] = [
  { id: 'latest', label: '最新' },
  { id: 'hot', label: '热门' },
  { id: 'foryou', label: '为你推荐' },
];

/** 合并进「知乎」一颗 chip 的来源组：主 chip 一键整组显隐，▾ 下拉里逐项开关 */
const ZHIHU_GROUP: SourceId[] = ['zhihu', 'answers', 'news', 'blogs'];

type Props = {
  sort: SortMode;
  onSortChange: (sort: SortMode) => void;
  /** 被隐藏的来源/子板块 key 集合（'zhihu'、'zhihu:hot'、'bilibili:rank'） */
  hiddenKeys: Set<string>;
  /** 切换整个来源的显示/隐藏 */
  onToggleSource: (source: SourceId) => void;
  /** 切换某来源下某子板块的显示/隐藏 */
  onToggleFeed: (source: SourceId, feed: string) => void;
  /** 一键显隐一组来源（知乎组 chip 的主体开关） */
  onToggleGroup: (sources: SourceId[]) => void;
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
 * 来源 chips 收敛成三颗（多选显隐模型）：
 *  - [全部]：一键恢复显示所有来源与子板块
 *  - [知乎 ▾]：代表 zhihu/answers/news/blogs 四个来源的组。主体点击整组显隐；
 *    ▾ 下拉面板里逐项开关——知乎的推荐/关注/热榜子板块 + 知乎回答/科技资讯/博客专栏
 *  - [B站 ▾]：整源显隐 + 热门/排行榜子板块下拉
 */
export default function TopBar({
  sort,
  onSortChange,
  hiddenKeys,
  onToggleSource,
  onToggleFeed,
  onToggleGroup,
  onShowAll,
  counts,
  feedCounts,
  total,
  onOpenMenu,
}: Props) {
  /** 当前打开下拉面板的 chip（null = 都没开） */
  const [menuSource, setMenuSource] = useState<SourceId | null>(null);
  /** chips 行底部在顶栏内的 y 坐标：下拉面板贴着它下方弹出（Modal 无状态栏偏移，坐标同源） */
  const [chipsBottom, setChipsBottom] = useState(0);

  const nothingHidden = hiddenKeys.size === 0;
  const groupMeta = SOURCES.find((s) => s.id === 'zhihu');
  const standalone = SOURCES.filter((s) => !ZHIHU_GROUP.includes(s.id));

  const groupCount = ZHIHU_GROUP.reduce((n, id) => n + (counts.get(id) ?? 0), 0);
  const groupAllHidden = ZHIHU_GROUP.every((id) => hiddenKeys.has(id));

  const handleChipsLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    setChipsBottom(y + height);
  };

  /** 「知乎」组下拉：知乎子板块 + 组内其余来源，逐项开关 */
  const buildZhihuRows = (): MenuRow[] => {
    const zhihuFeeds = groupMeta?.feeds ?? [];
    const zhihuSourceHidden = hiddenKeys.has('zhihu');
    return [
      ...zhihuFeeds.map((f) => ({
        key: `zhihu:${f.id}`,
        label: f.label,
        count: feedCounts.get(`zhihu:${f.id}`) ?? 0,
        on: !hiddenKeys.has(`zhihu:${f.id}`),
        dim: zhihuSourceHidden,
        onToggle: () => onToggleFeed('zhihu', f.id),
      })),
      ...ZHIHU_GROUP.filter((id) => id !== 'zhihu').map((id) => {
        const s = SOURCES.find((x) => x.id === id);
        return {
          key: id,
          label: s?.label ?? id,
          count: counts.get(id) ?? 0,
          on: !hiddenKeys.has(id),
          onToggle: () => onToggleSource(id),
        };
      }),
    ];
  };

  /** 普通带子板块来源（B站）的下拉 */
  const buildStandaloneRows = (sourceId: SourceId): MenuRow[] => {
    const s = SOURCES.find((x) => x.id === sourceId);
    const sourceHidden = hiddenKeys.has(sourceId);
    return (s?.feeds ?? []).map((f) => ({
      key: `${sourceId}:${f.id}`,
      label: f.label,
      count: feedCounts.get(`${sourceId}:${f.id}`) ?? 0,
      on: !hiddenKeys.has(`${sourceId}:${f.id}`),
      dim: sourceHidden,
      onToggle: () => onToggleFeed(sourceId, f.id),
    }));
  };

  const menu =
    menuSource === 'zhihu' && groupMeta
      ? {
          title: '知乎',
          master: {
            label: '整个知乎',
            hint: groupAllHidden ? '当前已隐藏组内全部内容' : '显示以下全部',
            on: !groupAllHidden,
            onToggle: () => onToggleGroup(ZHIHU_GROUP),
          },
          rows: buildZhihuRows(),
        }
      : menuSource && menuSource !== 'zhihu'
        ? {
            title: SOURCES.find((s) => s.id === menuSource)?.label ?? '',
            master: {
              label: `整个${SOURCES.find((s) => s.id === menuSource)?.label ?? ''}`,
              hint: hiddenKeys.has(menuSource) ? '当前已隐藏该来源全部内容' : '显示全部子板块',
              on: !hiddenKeys.has(menuSource),
              onToggle: () => onToggleSource(menuSource),
            },
            rows: buildStandaloneRows(menuSource),
          }
        : null;

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
        {groupMeta && (
          <SourceChip
            source={groupMeta}
            count={groupCount}
            hidden={groupAllHidden}
            hasMenu
            menuOpen={menuSource === 'zhihu'}
            onToggle={() => onToggleGroup(ZHIHU_GROUP)}
            onOpenMenu={() => setMenuSource(menuSource === 'zhihu' ? null : 'zhihu')}
          />
        )}
        {standalone.map((s) => (
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

      {menu && (
        <SourceMenu
          title={menu.title}
          master={menu.master}
          rows={menu.rows}
          panelTop={chipsBottom + 6}
          onClose={() => setMenuSource(null)}
        />
      )}
    </View>
  );
}

/** 普通筛选按钮（「全部」）：点击恢复全部显示，隐藏时变灰 */
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
 *  [● 知乎 42 | ▾] —— 主体点击整组/整源显隐，▾ 打开逐项开关面板；无子板块时退化为普通 Chip。
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
