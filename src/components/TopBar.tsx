import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SOURCES } from '../api/sources';
import type { SortMode, SourceFilter } from '../types';

const SORTS: { id: SortMode; label: string }[] = [
  { id: 'latest', label: '最新' },
  { id: 'hot', label: '热门' },
];

type Props = {
  sort: SortMode;
  onSortChange: (sort: SortMode) => void;
  activeSource: SourceFilter;
  onSourceChange: (source: SourceFilter) => void;
};

/** 顶栏：logo + 最新/热门排序 + 来源筛选 chips */
export default function TopBar({ sort, onSortChange, activeSource, onSourceChange }: Props) {
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
          active={activeSource === 'all'}
          onPress={() => onSourceChange('all')}
        />
        {SOURCES.map((s) => (
          <Chip
            key={s.id}
            label={s.label}
            dotColor={s.color}
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
  active,
  onPress,
}: {
  label: string;
  dotColor: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
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
    backgroundColor: '#f2f3f5',
    borderRadius: 16,
    padding: 2,
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
});
