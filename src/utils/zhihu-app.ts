/*
 * 知乎 App 深链（deep link）工具 —— 移植自 stories web 端 src/utils/zhihu-app.ts。
 *
 * ⚠️ 为什么不能用 Linking.openURL('intent://...')：
 *   老版本 RN 的 IntentModule 用 Intent.parseUri(url, URI_INTENT_SCHEME) 能解析
 *   intent:// 包装；但 RN 0.86 改成了
 *     Intent(Intent.ACTION_VIEW, Uri.parse(url).normalizeScheme())
 *   即把整个 URL 当普通 data —— intent: scheme 没有任何应用能处理，
 *   必然 ActivityNotFoundException → 回落浏览器（实测症状：打开 Edge）。
 *
 * ✅ 正确做法（Android）：expo-intent-launcher 显式构造 Intent：
 *     action = ACTION_VIEW, data = zhihu://<deepPath>, packageName = com.zhihu.android
 *   - 已装知乎 → 直接唤起知乎 App
 *   - 未装知乎 → startActivity 抛 ActivityNotFoundException → JS catch 回落浏览器
 *   显式包名不依赖 Android 11+ 的包可见性（<queries>）声明，也不用 canOpenURL。
 *
 * ✅ iOS：Linking.openURL('zhihu://...') 走原生 openURL（不需要 LSApplicationQueriesSchemes，
 *   那个限制只作用于 canOpenURL）；失败同样 catch 回落。
 *
 * 深链映射（知乎 App 注册的 scheme，与 web 端实测一致）：
 *   /question/{qid}              → zhihu://questions/{qid}
 *   /question/{qid}/answer/{aid} → zhihu://answers/{aid}
 *   /answer/{aid}                → zhihu://answers/{aid}
 *   zhuanlan.zhihu.com/p/{pid}   → zhihu://articles/{pid}
 *   /p/{pid}                     → zhihu://articles/{pid}
 *   /pin/{pid}                   → zhihu://pins/{pid}
 *   /people/{token}              → zhihu://people/{token}
 */
import { Linking, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

const ZHIHU_PACKAGE = 'com.zhihu.android';

/** 从知乎 https 链接解析出 App 深链路径（如 `answers/123`）；非知乎链接返回 null */
export function toZhihuDeepPath(url: string): string | null {
  // 用正则取 host + path：避免依赖 Hermes 的 URL 实现差异
  const m = url.match(/^https:\/\/(?:www\.)?(zhuanlan\.)?zhihu\.com\/([^\s?#]+)/i);
  if (!m) {
    return null;
  }
  const seg = m[2].split('/').filter(Boolean);
  const id = (i: number): string | null => (/^\d+$/.test(seg[i] ?? '') ? seg[i] : null);

  if (m[1]) {
    // zhuanlan.zhihu.com 专栏
    return seg[0] === 'p' && id(1) ? `articles/${seg[1]}` : null;
  }
  if (seg[0] === 'question' && id(1)) {
    // /question/{qid}/answer/{aid} → 优先直接打开这条回答
    return seg[2] === 'answer' && id(3) ? `answers/${seg[3]}` : `questions/${seg[1]}`;
  }
  if (seg[0] === 'answer' && id(1)) {
    return `answers/${seg[1]}`;
  }
  if (seg[0] === 'pin' && id(1)) {
    return `pins/${seg[1]}`;
  }
  if (seg[0] === 'p' && id(1)) {
    return `articles/${seg[1]}`;
  }
  if (seg[0] === 'people' && seg[1]) {
    return `people/${seg[1]}`;
  }
  return null;
}

/** 回落：系统浏览器打开原 https 链接 */
async function openInBrowser(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    // 无可处理该链接的应用时静默忽略
  }
}

/** iOS：直接 openURL zhihu:// scheme，失败回落浏览器 */
async function openIosDeepLink(deepPath: string, httpsUrl: string): Promise<void> {
  try {
    await Linking.openURL(`zhihu://${deepPath}`);
  } catch {
    await openInBrowser(httpsUrl);
  }
}

/** Android：expo-intent-launcher 显式 Intent（data + 包名），未装知乎时抛错回落 */
async function openAndroidDeepLink(deepPath: string, httpsUrl: string): Promise<void> {
  try {
    // FLAG_ACTIVITY_NEW_TASK：以独立任务栈唤起，避免把我们的 Activity 顶替掉
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: `zhihu://${deepPath}`,
      packageName: ZHIHU_PACKAGE,
      flags: 0x10000000, // Intent.FLAG_ACTIVITY_NEW_TASK
    });
  } catch {
    await openInBrowser(httpsUrl);
  }
}

/**
 * 打开条目原文：知乎链接优先唤起知乎 App，未装则回落系统浏览器；非知乎链接直接走浏览器。
 */
export async function openItemUrl(url?: string): Promise<void> {
  if (!url) {
    return;
  }
  const deepPath = toZhihuDeepPath(url);
  if (!deepPath) {
    await openInBrowser(url);
    return;
  }
  if (Platform.OS === 'android') {
    await openAndroidDeepLink(deepPath, url);
  } else {
    await openIosDeepLink(deepPath, url);
  }
}
