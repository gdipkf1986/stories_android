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
import { loadTimeline, SOURCES, sourceMeta, sourceWeight } from './src/api/sources';
import { loadRecommendations } from './src/api/recommendations';
import {
  flushFeedback,
  loadHiddenItemIds,
  markItemDisliked,
  markItemOpened,
  markItemSeen,
} from './src/api/feedback';
import { saveLikedItem } from './src/api/likes';
import { pushLikes, syncLikes } from './src/api/likes-sync';
import { loadHiddenFilters, saveHiddenFilters } from './src/api/filters';
import { computeHotPercentiles } from './src/utils/format';
import { openItemUrl } from './src/utils/zhihu-app';
import { interleaveBySource } from './src/utils/interleave';
import {
  downloadApk,
  fetchUpdateInfo,
  installApk,
  openUnknownSourceSettings,
  type UpdateInfo,
  type UpdatePhase,
} from './src/api/update';
import type { File as ExpoFile } from 'expo-file-system';
import FeedCard from './src/components/card/FeedCard';
import {
  IMPRESSION_VIEWABILITY_CONFIG,
  useSeenImpressions,
} from './src/hooks/useSeenImpressions';
import TopBar from './src/components/TopBar';
import HotTopics from './src/components/HotTopics';
import LoginScreen from './src/components/LoginScreen';
import ProfileScreen from './src/components/ProfileScreen';
import LikesScreen from './src/components/LikesScreen';
import AboutScreen from './src/components/AboutScreen';
import DrawerMenu from './src/components/DrawerMenu';
import UpdateBanner from './src/components/UpdateBanner';
import EdgeSwipeBack from './src/components/EdgeSwipeBack';
import type { RecommendationFeed, SortMode, SourceId, TimelineItem } from './src/types';

type Screen = 'feed' | 'profile' | 'likes' | 'about';

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

/** 根路由：信息流 / 画像 / 关于三个屏 + 顶部更新横幅 + 侧滑抽屉。token 失效统一回落到信息流的登录页 */
function Root() {
  const [screen, setScreen] = useState<Screen>('feed');
  const [drawerOpen, setDrawerOpen] = useState(false);
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
        <EdgeSwipeBack onSwipeBack={() => setScreen('feed')}>
          <ProfileScreen onBack={() => setScreen('feed')} onUnauthorized={() => setScreen('feed')} />
        </EdgeSwipeBack>
      ) : screen === 'likes' ? (
        <EdgeSwipeBack onSwipeBack={() => setScreen('feed')}>
          <LikesScreen onBack={() => setScreen('feed')} />
        </EdgeSwipeBack>
      ) : screen === 'about' ? (
        <EdgeSwipeBack onSwipeBack={() => setScreen('feed')}>
          <AboutScreen onBack={() => setScreen('feed')} />
        </EdgeSwipeBack>
      ) : (
        <TimelineScreen onOpenMenu={() => setDrawerOpen(true)} />
      )}
      {/* 抽屉挂在根路由：从信息流唤起，选中项切到对应屏 */}
      <DrawerMenu
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onOpenLikes={() => setScreen('likes')}
        onOpenProfile={() => setScreen('profile')}
        onOpenAbout={() => setScreen('about')}
      />
    </View>
  );
}

function TimelineScreen({ onOpenMenu }: { onOpenMenu: () => void }) {
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState<TimelineItem[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<SortMode>('foryou'); // 默认进「为你推荐」
  /** 被隐藏的来源/子板块 key（'zhihu'、'zhihu:hot'、'bilibili:rank'）；空集 = 全部显示 */
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());
  const [needLogin, setNeedLogin] = useState(false);
  /** 喜欢/不感兴趣移除的条目 id（启动时由持久隐藏名单恢复），本批数据里不再显示 */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  /** 本次会话点开过的条目：卡片就地折叠成灰底标题条（不立即消失），刷新/重启后随隐藏名单不再出现 */
  const [openedIds, setOpenedIds] = useState<Set<string>>(() => new Set());
  /** 本次会话因前台可见满 5 秒被标记已读的条目：立即套用同一套灰底折叠样式 */
  const [impressionReadIds, setImpressionReadIds] = useState<Set<string>>(() => new Set());
  /** 推荐流（为你推荐）：静态 JSON 单独加载，失败不影响时间线 */
  const [recFeed, setRecFeed] = useState<RecommendationFeed | null>(null);
  /** 本次启动内已确认曝光的条目；跨刷新合并，避免持久库读取和 5 秒计时竞争 */
  const seenIdsRef = useRef<Set<string>>(new Set());

  const handleImpressionViewable = useSeenImpressions((item) => {
    seenIdsRef.current.add(item.id);
    setImpressionReadIds((prev) => {
      if (prev.has(item.id)) return prev;
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
  });

  const listRef = useRef<FlatList<TimelineItem> | null>(null);
  /** 悬浮按钮在加载中也能触发刷新；序号丢弃过期请求，防止快速连按后旧数据覆盖新数据 */
  const fetchSeqRef = useRef(0);

  /** 点开和曝光满 5 秒共用「已读」视觉状态 */
  const readIds = useMemo(
    () => new Set([...openedIds, ...impressionReadIds]),
    [openedIds, impressionReadIds],
  );

  /** 并发拉全部数据源（内部 allSettled 容错）+ 推荐流 + 本地隐藏名单。
   *  首次进加载态，下拉进刷新态；点开过的条目直接滤掉（含首屏，不闪现），
   *  顺带补发上次没发出去的反馈事件。 */
  const fetchTimeline = useCallback(async ({ showRefresh = false } = {}) => {
    const requestSeq = ++fetchSeqRef.current;
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [result, hiddenIds, recs] = await Promise.all([
        loadTimeline(),
        loadHiddenItemIds(),
        loadRecommendations(),
      ]);
      const allHiddenIds = new Set(hiddenIds);
      for (const itemId of seenIdsRef.current) {
        allHiddenIds.add(itemId);
      }
      if (requestSeq !== fetchSeqRef.current) return;
      setHidden(allHiddenIds);
      setRecFeed(recs);
      setItems(result.items.filter((it) => !allHiddenIds.has(it.id)));
      setFailures(result.failures.map((f) => sourceMeta(f.source).label));
      setNeedLogin(result.unauthorized === true);
    } finally {
      if (requestSeq === fetchSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  /** 任何时候可从左下角回顶；滚回列表顶部的同时按下拉刷新链路重新拉取 */
  const handleScrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ animated: true, offset: 0 });
    void fetchTimeline({ showRefresh: true });
  }, [fetchTimeline]);

  useEffect(() => {
    fetchTimeline();
    void flushFeedback(); // 补发上次退出前没发完的事件
    void syncLikes(); // 收藏与服务端对账（推待上传的 + 拉多端合并的）
    void loadHiddenFilters().then(setHiddenKeys); // 恢复上次的来源/子板块显隐筛选
  }, [fetchTimeline]);

  /** 切换某个 key（来源或子板块）的显示/隐藏并持久化 */
  const toggleHiddenKey = useCallback(
    (key: string) => {
      const next = new Set(hiddenKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setHiddenKeys(next);
      void saveHiddenFilters(next);
    },
    [hiddenKeys],
  );

  const handleToggleSource = useCallback(
    (source: SourceId) => toggleHiddenKey(source),
    [toggleHiddenKey],
  );

  const handleToggleFeed = useCallback(
    (source: SourceId, feed: string) => toggleHiddenKey(`${source}:${feed}`),
    [toggleHiddenKey],
  );

  /** 一键显隐一组来源（知乎组 chip：全部隐藏时点击=整组显示，否则=整组隐藏）。
   *  子板块的隐藏状态不动，重新显示后各自的筛选保持原样。 */
  const handleToggleGroup = useCallback(
    (sources: SourceId[]) => {
      const allHidden = sources.every((id) => hiddenKeys.has(id));
      const next = new Set(hiddenKeys);
      sources.forEach((id) => (allHidden ? next.delete(id) : next.add(id)));
      setHiddenKeys(next);
      void saveHiddenFilters(next);
    },
    [hiddenKeys],
  );

  /** 一键恢复显示全部（清空隐藏集合） */
  const handleShowAll = useCallback(() => {
    if (hiddenKeys.size === 0) return;
    const next = new Set<string>();
    setHiddenKeys(next);
    void saveHiddenFilters(next);
  }, [hiddenKeys]);

  /** 点开一条（卡片点击）：记喜欢 + 入持久隐藏名单（刷新/重启后不再出现），
   *  但不立即从当前流移除——卡片就地折叠成灰底标题条，浏览节奏不被打断 */
  const handleOpened = useCallback((item: TimelineItem) => {
    setOpenedIds((prev) => {
      if (prev.has(item.id)) return prev;
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    markItemOpened(item);
  }, []);

  /** 点顶部「热门内容」榜的一行：与点卡片同一条路径——记点开反馈（喜欢 + 隐藏名单，
   *  对应卡片就地折叠）+ 深链唤起知乎/B站 App（未装回落浏览器） */
  const handleHotPress = useCallback(
    (item: TimelineItem) => {
      handleOpened(item);
      void openItemUrl(item.url);
    },
    [handleOpened],
  );

  /** 喜欢一条内容（手动按钮）：立即从信息流移除 + 记喜欢（本地状态 + 事件补发）
   *  + 存进本地「我喜欢」收藏夹（快照整个条目，永不过期，见 api/likes.ts）。
   *  只有手动点「♡ 喜欢」才进收藏夹；点开原文只是画像引擎的隐式正向信号（markItemOpened），
   *  不算「点过喜欢」，否则收藏夹会被阅读记录淹没。 */
  const handleLike = useCallback((item: TimelineItem) => {
    setHidden((prev) => {
      if (prev.has(item.id)) return prev;
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    void saveLikedItem(item);
    void pushLikes(); // 新收藏尽快推服务端备份（失败会留到下次启动/进收藏屏再推）
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

  /** 手动已读：立即移除；持久层与 5 秒曝光一致，刷新/重启后也不再出现 */
  const handleRead = useCallback((item: TimelineItem) => {
    setHidden((prev) => {
      if (prev.has(item.id)) return prev;
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
    void markItemSeen(item);
  }, []);

  /** 各来源条目数（TopBar 筛选 chips 上的计数，对齐 web 端 Sidebar） */
  const counts = useMemo(() => {
    const map = new Map<SourceId, number>();
    for (const it of items) {
      map.set(it.source, (map.get(it.source) ?? 0) + 1);
    }
    return map;
  }, [items]);

  /** 各子板块条目数（下拉面板里的计数），key 为 `${source}:${feed}` */
  const feedCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items) {
      if (!it.feed) continue;
      const key = `${it.source}:${it.feed}`;
      map.set(key, (map.get(key) ?? 0) + 1);
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

  /** 来源/子板块显隐过滤（去掉已点开的）+ 按排序模式排列 */
  const visible = useMemo(() => {
    const passes = (list: TimelineItem[]) =>
      list.filter(
        (it) =>
          !hiddenKeys.has(it.source) &&
          !(it.feed && hiddenKeys.has(`${it.source}:${it.feed}`)),
      );
    const alive = (list: TimelineItem[]) => list.filter((it) => !hidden.has(it.id));

    if (sort === 'foryou') {
      const recs = recFeed?.items ?? [];
      if (recs.length > 0) {
        // 只保留推荐流里有的条目，按推荐顺序输出
        const ordered = recs
          .map((r) => items.find((it) => it.id === r.id))
          .filter((it): it is TimelineItem => Boolean(it));
        return alive(passes(ordered));
      }
      // 推荐流还没生成/加载失败 → 回落最新序
      return alive(passes([...items].sort((a, b) => b.createdAt - a.createdAt)));
    }

    if (sort === 'latest') {
      // 加权交错：各源整批抓取、时间戳扎堆，纯按时间排会单源霸屏；
      // 改为源内最新优先 + 跨源按注册表权重交替出现
      return interleaveBySource(alive(passes(items)), sourceWeight);
    }

    // 热门：源内百分位归一化——B站播放(几十万)和知乎赞同(几千)量纲差太大，
    // 直接比原始热度会被单一来源刷屏；改比组内排名，各源最热内容平权交错
    const sorted = [...alive(passes(items))];
    const pct = computeHotPercentiles(sorted);
    sorted.sort((a, b) => (pct.get(b.id) ?? 0) - (pct.get(a.id) ?? 0) || b.createdAt - a.createdAt);
    return sorted;
  }, [items, hidden, hiddenKeys, sort, recFeed]);

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
        hiddenKeys={hiddenKeys}
        onToggleSource={handleToggleSource}
        onToggleFeed={handleToggleFeed}
        onToggleGroup={handleToggleGroup}
        onShowAll={handleShowAll}
        counts={counts}
        feedCounts={feedCounts}
        total={items.length}
        onOpenMenu={onOpenMenu}
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
          ref={listRef}
          data={visible}
          keyExtractor={(it) => it.id}
          extraData={readIds} // 已读状态不改 data：让 memo 的行重渲染
          renderItem={({ item }) => {
            const rec = sort === 'foryou' ? recIndex.get(item.id) : undefined;
            return (
              <FeedCard
                item={item}
                onOpened={handleOpened}
                onLike={handleLike}
                onDislike={handleDislike}
                onRead={handleRead}
                reason={rec?.reason}
                explore={rec?.explore}
                opened={readIds.has(item.id)}
              />
            );
          }}
          onViewableItemsChanged={handleImpressionViewable}
          viewabilityConfig={IMPRESSION_VIEWABILITY_CONFIG}
          ListHeaderComponent={<HotTopics items={visible} onOpenItem={handleHotPress} />}
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
              <Text style={styles.emptyText}>
                {items.length > 0 ? '当前筛选下没有内容，点「全部」恢复显示' : '暂无内容'}
              </Text>
            </View>
          }
        />
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="回到顶部并刷新"
        style={({ pressed }) => [
          styles.scrollToTop,
          { bottom: insets.bottom + 16 },
          pressed && styles.scrollToTopPressed,
        ]}
        onPress={handleScrollToTop}
      >
        <Text style={styles.scrollToTopIcon}>↑</Text>
      </Pressable>
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
  scrollToTop: {
    position: 'absolute',
    left: 16,
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d9dde3',
    elevation: 4,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14,
    shadowRadius: 5,
  },
  scrollToTopPressed: {
    backgroundColor: '#f0f3f7',
  },
  scrollToTopIcon: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '600',
    color: '#0084ff',
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
