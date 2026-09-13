import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SOURCES } from '../api/sources';
import type { SortMode, SourceFilter, SourceId } from '../types';

const SORTS: { id: SortMode; label: string }[] = [
  { id: 'latest', label: '最新' },
  { id: 'hot', label: '热门' },
  { id: 'foryou', label: '为你推荐' },
];

type Props = {
  sort: SortMode;
  onSortChange: (sort: SortMode) => void;
  activeSource: SourceFilter;
  onSourceChange: (source: SourceFilter) => void;
  /** 各数据源当前条目数（对齐 web 端 Sidebar 的计数） */
  counts: Map<SourceId, number>;
  /** 全部条目数 */
  total: number;
  /** 打开画像分析页 */
  onOpenProfile: () => void;
};

/** 顶栏：logo + 最新/热门/为你推荐排序 + 来源筛选 chips（带计数）+ 画像入口 */
export default function TopBar({
  sort,
  onSortChange,
  activeSource,
  onSourceChange,
  counts,
  total,
  onOpenProfile,
}: Props) {
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
          <Pressable style={styles.profileBtn} onPress={onOpenProfile} hitSlop={4}>
            <Text style={styles.profileBtnText}>画像</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipsScroll}
        contentContainerStyle={styles.chipsContent}
      >
        <Chip
          label="全部"
          dotColor="#0084ff"
          count={total}
          active={activeSource === 'all'}
          onPress={() => onSourceChange('all')}
        />
        {SOURCES.map((s) => (
          <Chip
            key={s.id}
            label={s.label}
            dotColor={s.color}
            count={counts.get(s.id) ?? 0}
            active={activeSource === s.id}
            onPress={() => onSourceChange(s.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

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
  profileBtn: {
    paddingHorizontal: 10,
  },
  profileBtnText: {
    fontSize: 13,
    color: '#0084ff',
    fontWeight: '600',
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
  chipCount: {
    fontSize: 11,
    color: '#a5adbb',
  },
  chipCountActive: {
    color: '#0084ff',
  },
});
