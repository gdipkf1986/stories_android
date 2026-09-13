import { Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import type { SourceId, SourceMeta } from '../types';

type Props = {
  source: SourceMeta;
  /** 面板顶部位置（chips 行底部 + 间距；Modal 内容与顶栏同以状态栏底为原点） */
  panelTop: number;
  /** 隐藏的来源/子板块 key 集合（'zhihu'、'zhihu:hot'） */
  hiddenKeys: Set<string>;
  /** 子板块条目数，key 为 `${source}:${feed}` */
  feedCounts: Map<string, number>;
  onToggleSource: (source: SourceId) => void;
  onToggleFeed: (source: SourceId, feed: string) => void;
  onClose: () => void;
};

/** 来源筛选下拉面板：整源开关 + 各子板块开关（点面板外关闭） */
export default function SourceMenu({
  source,
  panelTop,
  hiddenKeys,
  feedCounts,
  onToggleSource,
  onToggleFeed,
  onClose,
}: Props) {
  const sourceHidden = hiddenKeys.has(source.id);
  const feeds: SourceMeta['feeds'] = source.feeds ?? [];

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* 空 onPress：把面板内点击从 backdrop 手里截下来，防止误关 */}
        <Pressable style={[styles.panel, { marginTop: panelTop }]} onPress={() => {}}>
          <Text style={styles.title}>{source.label}</Text>

          <View style={styles.row}>
            <View style={styles.rowTextWrap}>
              <Text style={styles.rowLabel}>整个来源</Text>
              <Text style={styles.rowHint}>
                {sourceHidden ? '当前已隐藏该来源全部内容' : '显示该来源全部子板块'}
              </Text>
            </View>
            <Switch value={!sourceHidden} onValueChange={() => onToggleSource(source.id)} />
          </View>

          {feeds.length > 0 && <View style={styles.divider} />}
          {feeds.map((f) => {
            const key = `${source.id}:${f.id}`;
            const feedHidden = hiddenKeys.has(key);
            const count = feedCounts.get(key) ?? 0;
            return (
              <View key={f.id} style={styles.row}>
                <View style={styles.rowTextWrap}>
                  <Text style={[styles.rowLabel, sourceHidden && styles.rowLabelDim]}>
                    {f.label}
                  </Text>
                  {count > 0 && <Text style={styles.rowCount}>{count} 条</Text>}
                </View>
                <Switch
                  value={!feedHidden}
                  onValueChange={() => onToggleFeed(source.id, f.id)}
                />
              </View>
            );
          })}

          <Text style={styles.footnote}>筛选只影响信息流显示，重启后仍保留</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'flex-start',
  },
  panel: {
    marginHorizontal: 12,
    alignSelf: 'stretch',
    maxWidth: 360,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 6,
    paddingHorizontal: 14,
    // 阴影
    elevation: 8,
    shadowColor: '#000000',
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: '#8590a6',
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: 12,
  },
  rowTextWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  rowLabel: {
    fontSize: 15,
    color: '#1a1a1a',
  },
  rowLabelDim: {
    color: '#b9c0cc',
  },
  rowHint: {
    fontSize: 11,
    color: '#a5adbb',
  },
  rowCount: {
    fontSize: 11,
    color: '#a5adbb',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e8e8e8',
    marginVertical: 4,
  },
  footnote: {
    fontSize: 11,
    color: '#b9c0cc',
    paddingVertical: 8,
  },
});
