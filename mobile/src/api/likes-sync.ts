import { API_BASE } from './config';
import { getToken } from './auth';
import {
  isMergeable,
  markLikesSynced,
  mergeRemoteLikes,
  takeUnsyncedLikes,
  type LikeSyncRow,
} from './likes';

/**
 * 「我喜欢」服务端备份同步（POST/GET /api/likes，结构见 scraper/like-store.mjs）。
 *
 * 定位：本地 SQLite 是主存储（离线可用、秒开），服务端是跨设备/重装的备份。
 *  - push：synced_at IS NULL 的行批 ≤50 上传（与 /api/events 同一批量上限），
 *    成功才打同步戳；失败留着下次，绝不阻塞 UI
 *  - pull：全量拉取按 itemId 合并，只认严格更新的 likedAt（见 likes.ts mergeRemoteLikes）
 *  - 认证失败（401）与其他错误一律静默跳过，和其他尽力而为的后台调用同款
 */

/** 推送本地新增/更新的收藏（点「♡ 喜欢」后、App 启动时调用） */
export async function pushLikes(): Promise<void> {
  try {
    // 批次循环：一次没推完（>50 条待同步）下轮继续；上限防御脏数据死循环
    for (let round = 0; round < 20; round++) {
      const rows = await takeUnsyncedLikes(50);
      if (rows.length === 0) return;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      const token = await getToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const res = await fetch(`${API_BASE}/api/likes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ likes: rows }),
      });
      if (res.status === 401) return; // 未登录/过期：安静放弃，登录后自然重试
      if (!res.ok) return; // 网络故障：留着下次推
      await markLikesSynced(rows, Date.now());
      if (rows.length < 50) return;
    }
  } catch {
    // 尽力而为
  }
}

/** 拉取服务端收藏并合并进本地（进收藏屏时调用） */
export async function pullLikes(): Promise<void> {
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(`${API_BASE}/api/likes`, { headers });
    if (!res.ok) return;
    const parsed: unknown = await res.json();
    if (parsed === null || typeof parsed !== 'object') return;
    const likes = (parsed as { likes?: unknown }).likes;
    if (!Array.isArray(likes)) return;
    const rows = likes.filter(isMergeable) as LikeSyncRow[];
    if (rows.length > 0) {
      await mergeRemoteLikes(rows, Date.now());
    }
  } catch {
    // 尽力而为
  }
}

/** 全量同步：先拉（多端合并）后推（上传新收藏） */
export async function syncLikes(): Promise<void> {
  await pullLikes();
  await pushLikes();
}
