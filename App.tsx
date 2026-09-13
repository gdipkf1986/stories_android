import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadTimeline, SOURCES, sourceMeta } from './src/api/sources';
import { loadRecommendations } from './src/api/recommendations';
import { flushFeedback, loadHiddenItemIds, markItemDisliked, markItemOpened } from './src/api/feedback';
import { hotScore } from './src/utils/format';
import {
  downloadApk,
  fetchUpdateInfo,
  installApk,
  openUnknownSourceSettings,
  type UpdateInfo,
  type UpdatePhase,
} from './src/api/update';
import type { File as ExpoFile } from 'expo-file-system';
import TimelineCard from './src/components/TimelineCard';
import TopBar from './src/components/TopBar';
import HotTopics from './src/components/HotTopics';
import LoginScreen from './src/components/LoginScreen';
import ProfileScreen from './src/components/ProfileScreen';
import UpdateBanner from './src/components/UpdateBanner';
import type { RecommendationFeed, SortMode, SourceFilter, SourceId, TimelineItem } from './src/types';

type Screen = 'feed' | 'profile';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Root />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/** 根路由：信息流 / 画像分析两个屏 + 顶部更新横幅。token 失效统一回落到信息流的登录页 */
function Root() {
  const [screen, setScreen] = useState<Screen>('feed');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>({ state: 'idle' });
  const apkFile = useRef<ExpoFile | null>(null);

  // 启动静默查一次新版本（NAS 后端 latest.json；401/网络失败都不打扰）
  useEffect(() => {
    void fetchUpdateInfo().then(setUpdateInfo);
  }, []);

  const handleUpdatePress = useCallback(async () => {
    if (!updateInfo) return;
    // 已下载完 → 拉起系统安装器
    if (updatePhase.state === 'readyToInstall' && apkFile.current) {
      try {
        await installApk(apkFile.current);
      } catch {
        setUpdatePhase({ state: 'error', message: '无法拉起安装器' });
      }
      return;
    }
    if (updatePhase.state !== 'idle' && updatePhase.state !== 'error') return;
    try {
      setUpdatePhase({ state: 'downloading', written: 0, total: updateInfo.sizeBytes });
      const file = await downloadApk(updateInfo, (written, total) =>
        setUpdatePhase({ state: 'downloading', written, total }),
      );
      apkFile.current = file;
      setUpdatePhase({ state: 'readyToInstall', file });
    } catch (e) {
      setUpdatePhase({
        state: 'error',
        message: e instanceof Error ? e.message : '下载失败',
      });
    }
  }, [updateInfo, updatePhase]);

  return (
    <View style={styles.root}>
      {updateInfo && (
        <UpdateBanner
          info={updateInfo}
          phase={updatePhase}
          onPress={() => void handleUpdatePress()}
          onOpenSettings={() => void openUnknownSourceSettings()}
        />
      )}
      {screen === 'profile' ? (
        <ProfileScreen onBack={() => setScreen('feed')} onUnauthorized={() => setScreen('feed')} />
      ) : (
        <TimelineScreen onOpenProfile={() => setScreen('profile')} />
      )}
    </View>
  );
}

function TimelineScreen({ onOpenProfile }: { onOpenProfile: () => void }) {
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState<TimelineItem[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<SortMode>('latest');
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [needLogin, setNeedLogin] = useState(false);
  /** 点开过原文的条目：等价于喜欢，信息流里不再显示 */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  /** 推荐流（为你推荐）：静态 JSON 单独加载，失败不影响时间线 */
  const [recFeed, setRecFeed] = useState<RecommendationFeed | null>(null);

  /** 并发拉全部数据源（内部 allSettled 容错）+ 推荐流 + 本地隐藏名单。
   *  首次进加载态，下拉进刷新态；点开过的条目直接滤掉（含首屏，不闪现），
   *  顺带补发上次没发出去的反馈事件。 */
  const fetchTimeline = useCallback(async ({ showRefresh = false } = {}) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [result, hiddenIds, recs] = await Promise.all([
        loadTimeline(),
        loadHiddenItemIds(),
        loadRecommendations(),
      ]);
      setHidden(hiddenIds);
      setRecFeed(recs);
      setItems(result.items.filter((it) => !hiddenIds.has(it.id)));
      setFailures(result.failures.map((f) => sourceMeta(f.source).label));
      setNeedLogin(result.unauthorized === true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTimeline();
    void flushFeedback(); // 补发上次退出前没发完的事件
  }, [fetchTimeline]);

  /** 喜欢一条内容（手动按钮或点开原文）：立即从信息流移除 + 记喜欢（本地状态 + 事件补发） */
  const handleLike = useCallback((item: TimelineItem) => {
    setHidden((prev) => {
      if (prev.has(item.id)) return prev;
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    markItemOpened(item);
  }, []);

  /** 不感兴趣：立即从信息流移除 + 上报 dislike（强负向，服务端画像记避雷） */
  const handleDislike = useCallback((item: TimelineItem) => {
    setHidden((prev) => {
      if (prev.has(item.id)) return prev;
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    markItemDisliked(item);
  }, []);

  /** 各来源条目数（TopBar 筛选 chips 上的计数，对齐 web 端 Sidebar） */
  const counts = useMemo(() => {
    const map = new Map<SourceId, number>();
    for (const it of items) {
      map.set(it.source, (map.get(it.source) ?? 0) + 1);
    }
    return map;
  }, [items]);

  /** 推荐条目索引：id → 推荐元信息（分数/理由/探索位） */
  const recIndex = useMemo(() => {
    const map = new Map<string, { reason: string; explore: boolean }>();
    for (const r of recFeed?.items ?? []) {
      map.set(r.id, { reason: r.reason, explore: r.explore });
    }
    return map;
  }, [recFeed]);

  /** 来源过滤（去掉已点开的）+ 按排序模式排列 */
  const visible = useMemo(() => {
    const bySource = (list: TimelineItem[]) =>
      filter === 'all' ? list : list.filter((it) => it.source === filter);
    const alive = (list: TimelineItem[]) => list.filter((it) => !hidden.has(it.id));

    if (sort === 'foryou') {
      const recs = recFeed?.items ?? [];
      if (recs.length > 0) {
        // 只保留推荐流里有的条目，按推荐顺序输出
        const ordered = recs
          .map((r) => items.find((it) => it.id === r.id))
          .filter((it): it is TimelineItem => Boolean(it));
        return alive(bySource(ordered));
      }
      // 推荐流还没生成/加载失败 → 回落最新序
      return alive(bySource([...items].sort((a, b) => b.createdAt - a.createdAt)));
    }

    const sorted = [...alive(bySource(items))];
    if (sort === 'latest') {
      sorted.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      sorted.sort((a, b) => hotScore(b) - hotScore(a) || b.createdAt - a.createdAt);
    }
    return sorted;
  }, [items, hidden, filter, sort, recFeed]);

  const allFailed = !loading && items.length === 0 && failures.length === SOURCES.length;

  // token 缺失/失效（后端 401）→ 登录页；登录成功自动重新拉取
  if (needLogin) {
    return (
      <LoginScreen
        onLogin={() => {
          setNeedLogin(false);
          fetchTimeline();
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      <TopBar
        sort={sort}
        onSortChange={setSort}
        activeSource={filter}
        onSourceChange={setFilter}
        counts={counts}
        total={items.length}
        onOpenProfile={onOpenProfile}
      />

      {failures.length > 0 && !allFailed && !loading && (
        <Text style={styles.banner}>
          以下数据源加载失败：{failures.join('、')}（下拉可重试）
        </Text>
      )}

      {sort === 'foryou' && (recFeed?.coldStart ?? false) && !loading && (
        <Text style={styles.banner}>
          💡 画像还是空的：多点「喜欢 / 不感兴趣」，排序会越来越懂你（每次抓取后自动更新）
        </Text>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0084ff" />
        </View>
      ) : allFailed ? (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>加载失败</Text>
          <Text style={styles.errorText}>网络不可用或服务暂时无法访问</Text>
          <Pressable style={styles.retryBtn} onPress={() => fetchTimeline()}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(it) => it.id}
          renderItem={({ item }) => {
            const rec = sort === 'foryou' ? recIndex.get(item.id) : undefined;
            return (
              <TimelineCard
                item={item}
                onOpened={handleLike}
                onLike={handleLike}
                onDislike={handleDislike}
                reason={rec?.reason}
                explore={rec?.explore}
              />
            );
          }}
          ListHeaderComponent={<HotTopics items={items} />}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 16 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => fetchTimeline({ showRefresh: true })}
              colors={['#0084ff']}
              tintColor="#0084ff"
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>暂无内容</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  root: {
    flex: 1,
    backgroundColor: '#f6f6f6',
  },
  container: {
    flex: 1,
    backgroundColor: '#f6f6f6',
  },
  list: {
    // 卡片自带 marginTop，这里只管底部留白（contentContainerStyle 里动态加 insets.bottom）
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
  },
  banner: {
    marginHorizontal: 12,
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#fff7e6',
    color: '#ad6800',
    fontSize: 12,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  errorText: {
    fontSize: 14,
    color: '#8590a6',
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 8,
    backgroundColor: '#0084ff',
    borderRadius: 20,
    paddingHorizontal: 28,
    paddingVertical: 10,
  },
  retryText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyText: {
    fontSize: 14,
    color: '#8590a6',
  },
});
