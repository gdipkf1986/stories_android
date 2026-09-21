import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  EMPTY_PROFILE,
  countPendingVerdicts,
  fetchProfile,
  overlayVerdicts,
  submitVerdict,
  type ProfileData,
  type ProfileVerdict,
} from '../api/profile';

type Verdict = ProfileVerdict | 'none';

interface Props {
  /** 返回信息流 */
  onBack: () => void;
  /** 401（token 失效）→ 由外层切回信息流触发重新登录 */
  onUnauthorized: () => void;
}

/** 画像分析屏：展示系统学到的分析结果，每一条可「确认 / 反对」（用户裁决，AI 重算不覆盖） */
export default function ProfileScreen({ onBack, onUnauthorized }: Props) {
  const [data, setData] = useState<ProfileData>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [pendingCount, setPendingCount] = useState(0);

  const refreshPendingCount = useCallback(() => {
    void countPendingVerdicts().then(setPendingCount);
  }, []);

  const load = useCallback(
    async ({ showRefresh = false } = {}) => {
      if (showRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await fetchProfile();
        if (result.unauthorized) {
          onUnauthorized();
          return;
        }
        setLoadError(result.error ?? '');
        if (result.data) setData(result.data);
      } finally {
        setLoading(false);
        setRefreshing(false);
        refreshPendingCount();
      }
    },
    [onUnauthorized, refreshPendingCount],
  );

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 裁决：本地先行。立即写入本地缓存并乐观更新 UI（按钮瞬间生效），
   * POST /api/verdicts 由 submitVerdict 在后台异步补发，失败自动退避重试。
   */
  const decide = useCallback(
    (key: string, verdict: Verdict) => {
      setData((prev) => overlayVerdicts(prev, { [key]: verdict }));
      void submitVerdict(key, verdict).then(refreshPendingCount);
    },
    [refreshPendingCount],
  );

  const updatedAtText = (() => {
    if (!data.updatedAt) return '还没有生成画像';
    const d = new Date(data.updatedAt);
    const pad = (x: number) => String(x).padStart(2, '0');
    return `更新于 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();

  const hasData =
    data.topTags.length > 0 ||
    data.dislikedTags.length > 0 ||
    data.authorAffinity.length > 0 ||
    data.rejectedInterests.length > 0 ||
    data.rejectedAuthors.length > 0;

  return (
    <View style={styles.container}>
      {/* 顶栏：返回 + 标题 */}
      <View style={styles.topBar}>
        <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8}>
          <Text style={styles.backText}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>画像分析</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0084ff" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load({ showRefresh: true })}
              colors={['#0084ff']}
              tintColor="#0084ff"
            />
          }
        >
          <View style={styles.tipCard}>
            <Text style={styles.tipTitle}>
              {updatedAtText}
              {(data.stats.totalEvents ?? 0) > 0 ? ` · 累计行为 ${data.stats.totalEvents} 条` : ''}
            </Text>
            <Text style={styles.tipText}>
              这是系统从你的行为里学到的分析结果。每一条都可以
              <Text style={styles.tipBold}>确认</Text>（说得对，排序更信它）或
              <Text style={styles.tipBold}>反对</Text>
              （从画像和推荐里移除）。裁决会一直生效，重新分析也不会覆盖；权重变化在下一次画像/推荐更新后应用。
            </Text>
          </View>

          {!!loadError && <Text style={styles.errorBanner}>⚠️ 加载失败：{loadError}（下拉重试）</Text>}
          {pendingCount > 0 && (
            <Text style={styles.pendingBanner}>⏳ {pendingCount} 条裁决待同步，网络可用时自动补报</Text>
          )}

          {!hasData && (
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                还没有足够的浏览/反馈数据。{'\n'}回到信息流点几次「喜欢 / 不感兴趣」，再来看这里。
              </Text>
            </View>
          )}

          {data.topTags.length > 0 && (
            <Section title="兴趣画像" subtitle="你最近的内容偏好（权重 0~1，越高越影响排序）">
              {data.topTags.map((row) => {
                const key = `tag:${row.tag}`;
                return (
                  <Row
                    key={key}
                    name={row.tag}
                    weight={row.weight}
                    evidenceCount={row.evidenceCount}
                    verdict={row.verdict}
                    onDecide={(v) => decide(key, v)}
                    confirmLabel="说得对"
                    rejectLabel="不是这样"
                  />
                );
              })}
            </Section>
          )}

          {data.dislikedTags.length > 0 && (
            <Section title="避雷" subtitle="命中这些主题的内容不会进入推荐">
              {data.dislikedTags.map((row) => {
                const key = `dislike:${row.tag}`;
                return (
                  <Row
                    key={key}
                    name={row.tag}
                    badge="避雷"
                    badgeColor="#eb5f4a"
                    verdict={row.verdict}
                    onDecide={(v) => decide(key, v)}
                    confirmLabel="是雷点"
                    rejectLabel="不是雷点"
                    confirmIcon="💣"
                    rejectIcon="🍃"
                  />
                );
              })}
            </Section>
          )}

          {data.authorAffinity.length > 0 && (
            <Section title="作者亲和" subtitle="你互动较多的作者（反对后其内容不再进入推荐）">
              {data.authorAffinity.map((row) => {
                const key = `author:${row.author}`;
                return (
                  <Row
                    key={key}
                    name={row.author}
                    weight={row.weight}
                    verdict={row.verdict}
                    onDecide={(v) => decide(key, v)}
                    confirmLabel="喜欢 ta"
                    rejectLabel="别推 ta"
                  />
                );
              })}
            </Section>
          )}

          {(data.rejectedInterests.length > 0 || data.rejectedAuthors.length > 0) && (
            <Section title="已反对的分析" subtitle="撤销后相关行为证据会重新参与画像">
              <View style={styles.chipWrap}>
                {data.rejectedInterests.map((tag) => (
                  <UndoChip
                    key={`tag:${tag}`}
                    label={`兴趣「${tag}」`}
                    onUndo={() => decide(`tag:${tag}`, 'none')}
                  />
                ))}
                {data.rejectedAuthors.map((author) => (
                  <UndoChip
                    key={`author:${author}`}
                    label={`作者「${author}」`}
                    onUndo={() => decide(`author:${author}`, 'none')}
                  />
                ))}
              </View>
            </Section>
          )}

          {Object.keys(data.sourceAffinity).length > 0 && (
            <Section title="来源分布" subtitle="你的行为在各数据源上的分布（只读）">
              {Object.entries(data.sourceAffinity)
                .sort((a, b) => b[1] - a[1])
                .map(([source, weight]) => (
                  <View key={source} style={styles.row}>
                    <View style={styles.rowHead}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {source}
                      </Text>
                      <Text style={styles.weight}>{weight.toFixed(2)}</Text>
                    </View>
                    <View style={styles.barTrack}>
                      <View style={[styles.barFill, styles.barSource, { width: `${Math.round(weight * 100)}%` }]} />
                    </View>
                  </View>
                ))}
            </Section>
          )}

          <Text style={styles.footerNote}>下拉刷新 · 每日抓取后自动更新</Text>
        </ScrollView>
      )}
    </View>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionSub}>{subtitle}</Text>
      {children}
    </View>
  );
}

function Row({
  name,
  weight,
  badge,
  badgeColor = '#0084ff',
  evidenceCount,
  verdict,
  onDecide,
  confirmLabel,
  rejectLabel,
  confirmIcon = '👍',
  rejectIcon = '👎',
}: {
  name: string;
  weight?: number;
  badge?: string;
  badgeColor?: string;
  evidenceCount?: number;
  verdict: ProfileVerdict | null;
  onDecide: (verdict: Verdict) => void;
  confirmLabel: string;
  rejectLabel: string;
  /** 确认按钮图标；避雷区用 💣/🍃 与兴趣区的 👍/👎 区分开，防误触 */
  confirmIcon?: string;
  rejectIcon?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.rowName} numberOfLines={1}>
          {name}
        </Text>
        {badge && (
          <View style={[styles.badge, { borderColor: badgeColor }]}>
            <Text style={[styles.badgeText, { color: badgeColor }]}>{badge}</Text>
          </View>
        )}
        {typeof weight === 'number' && <Text style={styles.weight}>{weight.toFixed(2)}</Text>}
        {typeof evidenceCount === 'number' && evidenceCount > 0 && (
          <Text style={styles.evidence}>{evidenceCount} 条证据</Text>
        )}
      </View>

      {typeof weight === 'number' && (
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${Math.round(weight * 100)}%` }]} />
        </View>
      )}

      {verdict !== null ? (
        <View style={styles.verdictDone}>
          <View
            style={[
              styles.verdictBadge,
              verdict === 'confirmed' ? styles.badgeConfirmed : styles.badgeRejected,
            ]}
          >
            <Text
              style={[
                styles.verdictBadgeText,
                { color: verdict === 'confirmed' ? '#00a67e' : '#eb5f4a' },
              ]}
            >
              {verdict === 'confirmed' ? '✓ 已确认' : '✗ 已反对'}
            </Text>
          </View>
          <Pressable onPress={() => onDecide('none')} hitSlop={6}>
            <Text style={styles.undoText}>撤销</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.verdictRow}>
          <Pressable style={styles.verdictBtn} onPress={() => onDecide('confirmed')}>
            <Text style={styles.btnConfirmText}>{confirmIcon} {confirmLabel}</Text>
          </Pressable>
          <Pressable style={styles.verdictBtn} onPress={() => onDecide('rejected')}>
            <Text style={styles.btnRejectText}>{rejectIcon} {rejectLabel}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function UndoChip({ label, onUndo }: { label: string; onUndo: () => void }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipLabel}>{label}</Text>
      <Pressable onPress={onUndo} hitSlop={6}>
        <Text style={styles.chipUndo}>撤销</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f6f6f6',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8e8e8',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  backBtn: {
    marginRight: 12,
  },
  backText: {
    fontSize: 15,
    color: '#0084ff',
    fontWeight: '500',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: '#121212',
  },
  scrollContent: {
    padding: 12,
    paddingBottom: 32,
    gap: 12,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 8,
  },
  tipCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    elevation: 1,
  },
  tipTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 6,
  },
  tipText: {
    fontSize: 13,
    lineHeight: 20,
    color: '#8590a6',
  },
  tipBold: {
    fontWeight: '600',
    color: '#1a1a1a',
  },
  errorBanner: {
    backgroundColor: '#fff7e6',
    color: '#ad6800',
    fontSize: 12,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  pendingBanner: {
    color: '#8590a6',
    fontSize: 12,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#f2f3f5',
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 22,
    color: '#8590a6',
    textAlign: 'center',
  },
  section: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    elevation: 1,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#121212',
  },
  sectionSub: {
    fontSize: 12,
    color: '#8590a6',
    marginTop: 2,
    marginBottom: 10,
  },
  row: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f0f0f0',
    paddingVertical: 10,
    gap: 8,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowName: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  badge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  badgeText: {
    fontSize: 11,
  },
  weight: {
    fontSize: 12,
    color: '#8590a6',
    marginLeft: 'auto',
  },
  evidence: {
    fontSize: 12,
    color: '#a5adbb',
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: '#f2f3f5',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: '#0084ff',
  },
  barSource: {
    backgroundColor: '#00a67e',
  },
  verdictRow: {
    flexDirection: 'row',
    gap: 8,
  },
  verdictBtn: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#dcdfe4',
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  btnConfirmText: {
    fontSize: 12,
    color: '#555555',
  },
  btnRejectText: {
    fontSize: 12,
    color: '#555555',
  },
  verdictDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  verdictBadge: {
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeConfirmed: {
    backgroundColor: '#eef9f4',
    borderColor: '#00a67e',
  },
  badgeRejected: {
    backgroundColor: '#fdf1ef',
    borderColor: '#eb5f4a',
  },
  verdictBadgeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  undoText: {
    fontSize: 12,
    color: '#0084ff',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#f2f3f5',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipLabel: {
    fontSize: 13,
    color: '#555555',
  },
  chipUndo: {
    fontSize: 13,
    color: '#0084ff',
    fontWeight: '500',
  },
  footerNote: {
    textAlign: 'center',
    fontSize: 12,
    color: '#a5adbb',
    paddingTop: 4,
  },
});
