import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { API_BASE, LAN_API_BASE } from './config';
import { getToken } from './auth';

/**
 * 应用内更新：
 * 1. 打开/回前台时查 latest.json（带 Bearer，NAS 端由 publish-apk.sh 生成）
 * 2. 本机 versionCode（= CI run number）小于远端 → 有新版本
 * 3. 下载 APK 到缓存目录（带进度），转 content:// URI 拉起系统安装器
 *
 * GitHub 直连不可行的原因：仓库是私有的，artifact/release 都要鉴权，
 * 把 token 打进 APK 等于泄露；所以分发走 NAS 镜像（gh 拉取 → publish-apk.sh 发布）。
 * NAS 同机局域网可达时优先走 192.168.0.89:20001，APK 下载更快。
 */

export interface UpdateInfo {
  version: string;
  versionCode: number;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  url: string; // 相对路径 /data/app/xxx.apk
}

export type UpdatePhase =
  | { state: 'idle' }
  | { state: 'downloading'; written: number; total: number }
  | { state: 'readyToInstall'; file: File }
  | { state: 'error'; message: string };

/** 更新检查结果（比 fetchUpdateInfo 多区分「已是最新」和「检查失败」，关于页用） */
export type UpdateCheckResult =
  | { status: 'up-to-date'; installedVersion: string; installedCode: number }
  | { status: 'available'; info: UpdateInfo; installedVersion: string; installedCode: number }
  | { status: 'unavailable'; reason: 'not-logged-in' | 'network' | 'no-release' };

const LAN_PROBE_CACHE_MS = 30_000;
let preferredUpdateBase = API_BASE;
let preferredUpdatedAt = 0;
let preferredUpdateBasePromise: Promise<string> | null = null;

/** 访问免认证登录页，既能探测内网连通性，也能确认这确实是 stories 后端。 */
async function isLanBackendReachable(): Promise<boolean> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 1500);
  try {
    const res = await fetch(`${LAN_API_BASE}/login`, { signal: timeout.signal });
    if (!res.ok) return false;
    return (await res.text()).includes('<title>stories');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 短缓存探测结果，避免启动时多个请求重复打内网；离家后 30 秒内自动回落公网。 */
export async function resolveUpdateBase(): Promise<string> {
  if (Date.now() - preferredUpdatedAt < LAN_PROBE_CACHE_MS) return preferredUpdateBase;
  if (!preferredUpdateBasePromise) {
    preferredUpdateBasePromise = isLanBackendReachable()
      .then((reachable) => {
        preferredUpdateBase = reachable ? LAN_API_BASE : API_BASE;
        preferredUpdatedAt = Date.now();
        return preferredUpdateBase;
      })
      .finally(() => {
        preferredUpdateBasePromise = null;
      });
  }
  return preferredUpdateBasePromise;
}

/** 查询远端最新版本，区分四种结果；fetchUpdateInfo 是它的静默折叠版 */
export async function checkUpdate(): Promise<UpdateCheckResult> {
  const installedVersion = String(Application.nativeApplicationVersion ?? 'dev');
  const installed = Number(Application.nativeBuildVersion ?? '0');
  try {
    const token = await getToken();
    if (!token) return { status: 'unavailable', reason: 'not-logged-in' };
    const updateBase = await resolveUpdateBase();
    const res = await fetch(`${updateBase}/data/app/latest.json`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { status: 'unavailable', reason: 'no-release' };
    const raw = (await res.json()) as Partial<UpdateInfo>;
    if (
      typeof raw.versionCode !== 'number' ||
      typeof raw.fileName !== 'string' ||
      typeof raw.url !== 'string'
    ) {
      return { status: 'unavailable', reason: 'no-release' };
    }
    if (!Number.isFinite(installed) || raw.versionCode <= installed) {
      return { status: 'up-to-date', installedVersion, installedCode: installed };
    }
    return {
      status: 'available',
      installedVersion,
      installedCode: installed,
      info: {
        version: String(raw.version ?? ''),
        versionCode: raw.versionCode,
        fileName: raw.fileName,
        sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0,
        sha256: typeof raw.sha256 === 'string' ? raw.sha256 : '',
        url: raw.url,
      },
    };
  } catch {
    return { status: 'unavailable', reason: 'network' };
  }
}

/** 查询远端最新版本；无新版本 / 网络失败 / 未登录 → null（静默，不打扰） */
export async function fetchUpdateInfo(): Promise<UpdateInfo | null> {
  const result = await checkUpdate();
  return result.status === 'available' ? result.info : null;
}

/** 下载 APK 到缓存目录；同版本号文件已存在时直接复用（断点重进不用重下） */
export async function downloadApk(
  info: UpdateInfo,
  onProgress?: (written: number, total: number) => void,
): Promise<File> {
  const token = await getToken();
  const dest = new File(Paths.cache, info.fileName);
  if (dest.exists && dest.size === info.sizeBytes) {
    return dest; // 已下载过且大小一致
  }
  if (dest.exists) dest.delete();
  const updateBase = await resolveUpdateBase();
  const task = File.createDownloadTask(`${updateBase}${info.url}`, dest, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    onProgress: ({ bytesWritten, totalBytes }) => onProgress?.(bytesWritten, totalBytes),
  });
  // 任务被取消等异常场景会 resolve null，统一按失败处理
  const file = await task.downloadAsync();
  if (!file) throw new Error('下载中断');
  return file;
}

/** 拉起系统安装器（file:// → content://，授权安装器读临时文件） */
export async function installApk(file: File): Promise<void> {
  const contentUri = await FileSystem.getContentUriAsync(file.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
  });
}

/** 跳转「安装未知应用」授权页（Android 8+ 首次装包前需要允许本应用） */
export async function openUnknownSourceSettings(): Promise<void> {
  await IntentLauncher.startActivityAsync(
    IntentLauncher.ActivityAction.MANAGE_UNKNOWN_APP_SOURCES,
    { data: `package:${Application.applicationId ?? 'io.johuh.stories'}` },
  );
}
