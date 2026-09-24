import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { markItemSeen } from '../api/feedback';
import type { TimelineItem } from '../types';

interface ViewToken<T> {
  item: T;
}

interface ViewableItemsChangedEvent<T> {
  viewableItems: ViewToken<T>[];
}

interface Impression {
  item: TimelineItem;
  remainingMs: number;
  startedAt: number | null;
}

/** 卡片至少一半进入屏幕，且在前台连续保持 5 秒，才认为用户真的看过 */
export const VISIBLE_PERCENT_THRESHOLD = 50;
const SEEN_THRESHOLD_MS = 5_000;
const TICK_MS = 250;

/** 固定引用可避免 FlatList 因 viewabilityConfig 重建而重置可见性回调 */
export const IMPRESSION_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: VISIBLE_PERCENT_THRESHOLD,
} as const;

/**
 * 追踪 FlatList 里真实可见的卡片。App 切后台/锁屏时暂停计时；
 * 满足时长后持久化，onSeen 只在写入成功后触发。
 */
export function useSeenImpressions(onSeen: (item: TimelineItem) => void) {
  const onSeenRef = useRef(onSeen);
  const impressionsRef = useRef(new Map<string, Impression>());
  const persistedIdsRef = useRef(new Set<string>());
  const pendingIdsRef = useRef(new Set<string>());

  useEffect(() => {
    onSeenRef.current = onSeen;
  }, [onSeen]);

  const pauseImpressions = useCallback(() => {
    const now = Date.now();
    for (const impression of impressionsRef.current.values()) {
      if (impression.startedAt === null) continue;
      impression.remainingMs += now - impression.startedAt;
      impression.startedAt = null;
    }
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        const now = Date.now();
        for (const impression of impressionsRef.current.values()) {
          impression.startedAt = now;
        }
        return;
      }
      pauseImpressions();
    });

    return () => {
      subscription.remove();
    };
  }, [pauseImpressions]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      const now = Date.now();
      for (const [itemId, impression] of impressionsRef.current) {
        if (impression.startedAt === null || persistedIdsRef.current.has(itemId)) continue;
        const seenMs = impression.remainingMs + (now - impression.startedAt);
        if (seenMs < SEEN_THRESHOLD_MS || pendingIdsRef.current.has(itemId)) continue;

        pendingIdsRef.current.add(itemId);
        void markItemSeen(impression.item)
          .then(() => {
            persistedIdsRef.current.add(itemId);
            onSeenRef.current(impression.item);
          })
          .catch(() => {
            // 下一轮计时会重试，曝光状态不能因一次本地存储失败丢失
          })
          .finally(() => {
            pendingIdsRef.current.delete(itemId);
          });
      }
    }, TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  return useCallback((event: ViewableItemsChangedEvent<TimelineItem>) => {
    const nextIds = new Set(event.viewableItems.map(({ item }) => item.id));
    const impressions = impressionsRef.current;

    for (const itemId of [...impressions.keys()]) {
      if (!nextIds.has(itemId)) {
        const impression = impressions.get(itemId);
        if (impression?.startedAt != null) {
          impression.remainingMs += Date.now() - impression.startedAt;
        }
        impressions.delete(itemId);
      }
    }

    const now = Date.now();
    for (const item of event.viewableItems.map(({ item }) => item)) {
      const existing = impressions.get(item.id);
      if (existing) {
        existing.item = item;
        continue;
      }
      impressions.set(item.id, {
        item,
        remainingMs: 0,
        startedAt: AppState.currentState === 'active' ? now : null,
      });
    }
  }, []);
}
