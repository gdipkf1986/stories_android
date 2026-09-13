import { Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

/** 面板里的一行开关：可以是子板块（zhihu:hot），也可以是独立来源（bilibili） */
export interface MenuRow {
  key: string;
  label: string;
  /** 条目数，缺省不显示 */
  count?: number;
  /** true = 显示中 */
  on: boolean;
  /** 置灰（如所属来源整组隐藏时，子板块行失效） */
  dim?: boolean;
  onToggle: () => void;
}

type Props = {
  title: string;
  /** 面板顶部位置（chips 行底部 + 间距；Modal 内容与顶栏同以状态栏底为原点） */
  panelTop: number;
  /** 顶部的整组开关（如「整个知乎」一键显隐组内全部来源/子板块），可选 */
  master?: {
    label: string;
    hint: string;
    on: boolean;
    onToggle: () => void;
  };
  rows: MenuRow[];
  onClose: () => void;
};

/** 来源筛选下拉面板：整组开关 + 各行独立开关（点面板外关闭） */
export default function SourceMenu({ title, panelTop, master, rows, onClose }: Props) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* 空 onPress：把面板内点击从 backdrop 手里截下来，防止误关 */}
        <Pressable style={[styles.panel, { marginTop: panelTop }]} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>

          {master && (
            <View style={styles.row}>
              <View style={styles.rowTextWrap}>
                <Text style={styles.rowLabel}>{master.label}</Text>
                <Text style={styles.rowHint}>{master.hint}</Text>
              </View>
              <Switch value={master.on} onValueChange={master.onToggle} />
            </View>
          )}

          {master && rows.length > 0 && <View style={styles.divider} />}
          {rows.map((row) => (
            <View key={row.key} style={styles.row}>
              <View style={styles.rowTextWrap}>
                <Text style={[styles.rowLabel, row.dim && styles.rowLabelDim]}>{row.label}</Text>
                {!!row.count && row.count > 0 && <Text style={styles.rowCount}>{row.count} 条</Text>}
              </View>
              <Switch value={row.on} onValueChange={row.onToggle} />
            </View>
          ))}

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
