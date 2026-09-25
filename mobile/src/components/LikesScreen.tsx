import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOutUp } from 'react-native-reanimated';
import { deleteLikedItem, loadLikedItems, type LikedItem } from '../api/likes';
import { syncLikes } from '../api/likes-sync';
import { sourceMeta } from '../api/sources';
import { openItemUrl } from '../utils/zhihu-app';

/**
 * 「我喜欢」屏：本地收藏夹，列出所有点过「♡ 喜欢」的条目，按喜欢时间倒序。
 * 主数据是本地 SQLite 快照（api/likes.ts），不依赖服务端时间线——旧条目不因抓取
 * JSON 过期而消失，离线也能看；进屏时后台与服务端对一次账（api/likes-sync.ts，
 * 多设备/重装恢复用），点条目复用深链逻辑打开原文。
 */
export default function LikesScreen({ onBack }: { onBack: () => void }) {
  /** null = 还在读本地库（毫秒级，只闪一帧）；[] = 真的没收藏 */
  const [items, setItems] = useState<LikedItem[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const listVersionRef = useRef(0);

  // 每次进屏：先立刻展示本地，随后静默同步并按合并结果重渲染一次
  useEffect(() => {
    const version = ++listVersionRef.current;
    const sync = async () => {
      setItems(await loadLikedItems());
      await syncLikes();
      if (listVersionRef.current === version) setItems(await loadLikedItems());
    };
    void sync();
  }, []);

  const handleDelete = useCallback(async (item: LikedItem) => {
    if (deletingId) return;
    setDeletingId(item.id);
    const deleteVersion = ++listVersionRef.current;
    setItems((prev) => prev?.filter((liked) => liked.id !== item.id) ?? prev);
    try {
      await deleteLikedItem(item.id);
    } catch {
      const latest = await loadLikedItems();
      if (listVersionRef.current === deleteVersion) {
        setItems(latest);
        Alert.alert('删除失败', '请检查网络后重试');
      }
    } finally {
      setDeletingId(null);
    }
  }, [deletingId]);

  const handleDeleteRequest = useCallback((item: LikedItem) => {
    Alert.alert('删除这条喜欢？', item.title, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void handleDelete(item) },
    ]);
  }, [handleDelete]);

  return (
    <View style={styles.container}>
      {/* 顶栏：返回 + 标题（与画像/关于屏同款） */}
      <View style={styles.topBar}>
        <Pressable style={styles.backBtn} onPress={onBack} hitSlop={8}>
          <Text style={styles.backText}>← 返回</Text>
        </Pressable>
        <Text style={styles.title}>我喜欢</Text>
      </View>

      {items === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0084ff" />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          renderItem={({ item }) => (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOutUp.duration(180)}>
              <LikeRow item={item} deleting={deletingId === item.id} onDelete={handleDeleteRequest} />
            </Animated.View>
          )}
          ListHeaderComponent={
            items.length > 0 ? (
              <Text style={styles.summary}>
                共 {items.length} 条 · 按喜欢时间倒序 · 本机与服务端双备份
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>还没有喜欢的内容</Text>
              <Text style={styles.emptyText}>
                回到信息流，点卡片下方的「♡ 喜欢」{'\n'}
                收藏会一直留在这里，不会过期
              </Text>
            </View>
          }
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

function LikeRow({
  item,
  deleting,
  onDelete,
}: {
  item: LikedItem;
  deleting: boolean;
  onDelete: (item: LikedItem) => void;
}) {
  const meta = sourceMeta(item.source);
  /** 封面加载失败 → 隐藏缩略图，退化为纯文字行 */
  const [coverFailed, setCoverFailed] = useState(false);
  const openable = Boolean(item.url);

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={openable ? () => void openItemUrl(item.url) : undefined}
      onLongPress={() => onDelete(item)}
      disabled={deleting}
      android_ripple={{ color: '#0000000a' }}
    >
      <View style={styles.rowMain}>
        <View style={styles.metaRow}>
          <Text style={[styles.source, { color: meta.color }]}>{meta.label}</Text>
          <Text style={styles.author} numberOfLines={1}>
            {item.author || '未知作者'}
          </Text>
          <Text style={styles.likedAt}>{formatLikedAt(item.likedAt)}</Text>
        </View>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {item.title}
        </Text>
        {!!item.excerpt && (
          <Text style={styles.excerpt} numberOfLines={2}>
            {item.excerpt}
          </Text>
        )}
      </View>
      {openable && item.cover && !coverFailed && (
        <Image
          source={{ uri: item.cover }}
          style={styles.cover}
          onError={() => setCoverFailed(true)}
        />
      )}
    </Pressable>
  );
}

/** 收藏时间用绝对日期：收藏夹是「永不过期」的，几年前的条目相对时间（x 天前）没有意义 */
function formatLikedAt(t: number): string {
  const d = new Date(t);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  summary: {
    fontSize: 12,
    color: '#a5adbb',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 2,
  },
  list: {
    paddingBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    marginHorizontal: 12,
    marginTop: 10,
    padding: 14,
    elevation: 1,
  },
  rowPressed: {
    backgroundColor: '#f7f8fa',
  },
  rowMain: {
    flex: 1,
    gap: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  source: {
    fontSize: 12,
    fontWeight: '600',
  },
  author: {
    flexShrink: 1,
    fontSize: 12,
    color: '#8590a6',
  },
  likedAt: {
    marginLeft: 'auto',
    fontSize: 11,
    color: '#a5adbb',
  },
  rowTitle: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '500',
    color: '#121212',
  },
  excerpt: {
    fontSize: 13,
    lineHeight: 19,
    color: '#8590a6',
  },
  cover: {
    width: 84,
    height: 56,
    borderRadius: 8,
    backgroundColor: '#f2f3f5',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  emptyText: {
    fontSize: 13,
    lineHeight: 21,
    color: '#8590a6',
    textAlign: 'center',
  },
});
