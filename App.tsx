import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { hotScore } from './src/utils/format';
import TimelineCard from './src/components/TimelineCard';
import TopBar from './src/components/TopBar';
import LoginScreen from './src/components/LoginScreen';
import type { SortMode, SourceFilter, TimelineItem } from './src/types';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safe} edges={['top']}>
        <TimelineScreen />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function TimelineScreen() {
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState<TimelineItem[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<SortMode>('latest');
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [needLogin, setNeedLogin] = useState(false);

  /** 并发拉全部数据源（内部 allSettled 容错），首次进加载态，下拉进刷新态 */
  const fetchTimeline = useCallback(async ({ showRefresh = false } = {}) => {
    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await loadTimeline();
      setItems(result.items);
      setFailures(result.failures.map((f) => sourceMeta(f.source).label));
      setNeedLogin(result.unauthorized === true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTimeline();
  }, [fetchTimeline]);

  /** 筛选 + 排序（最新按时间倒序；热门按热度分，并列时新的在前） */
  const visible = useMemo(() => {
    const list = filter === 'all' ? items : items.filter((it) => it.source === filter);
    const sorted = [...list];
    if (sort === 'latest') {
      sorted.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      sorted.sort((a, b) => hotScore(b) - hotScore(a) || b.createdAt - a.createdAt);
    }
    return sorted;
  }, [items, filter, sort]);

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
      />

      {failures.length > 0 && !allFailed && !loading && (
        <Text style={styles.banner}>
          以下数据源加载失败：{failures.join('、')}（下拉可重试）
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
          renderItem={({ item }) => <TimelineCard item={item} />}
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
