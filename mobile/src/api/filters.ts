import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 来源/子板块显隐筛选的本地持久化。
 *
 * key 约定（与条目无耦合，纯字符串集合）：
 *  - 来源级：`${source}`，如 'zhihu'、'bilibili'
 *  - 子板块级：`${source}:${feed}`，如 'zhihu:hot'、'bilibili:rank'
 * 集合里存的是「被隐藏」的 key；不在集合里 = 显示。
 */
const VISIBILITY_KEY = 'stories.source-visibility';

/** 读取隐藏的来源/子板块 key 集合；损坏或缺失视为全显示 */
export async function loadHiddenFilters(): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse((await AsyncStorage.getItem(VISIBILITY_KEY)) ?? '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === 'string' && k.length > 0));
  } catch {
    return new Set();
  }
}

/** 保存隐藏的来源/子板块 key 集合（写失败静默忽略，下次退出再试） */
export async function saveHiddenFilters(keys: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(VISIBILITY_KEY, JSON.stringify([...keys]));
  } catch {
    // 存储失败不影响功能，只是下次启动可能恢复不了筛选
  }
}
