/*
 * 知乎 App 深链（deep link）工具 —— 移植自 stories web 端 src/utils/zhihu-app.ts。
 *
 * 原生 App 里比网页更简单：Linking.openURL 一个 intent:// 包装的深链，
 * 显式指定知乎包名（com.zhihu.android）：
 *   - 已装知乎 → 直接唤起知乎 App
 *   - 未装知乎 → startActivity 抛 ActivityNotFoundException → promise reject
 *     → JS 回落到原 https 链接（系统浏览器）
 * 显式包名不依赖 Android 11+ 的包可见性（<queries>）声明，也不用 canOpenURL。
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
import { Linking } from 'react-native';

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

/**
 * 打开条目原文：知乎链接优先唤起知乎 App，未装则回落系统浏览器；非知乎链接直接走浏览器。
 */
export async function openItemUrl(url?: string): Promise<void> {
  if (!url) {
    return;
  }
  const deepPath = toZhihuDeepPath(url);
  if (deepPath) {
    const intent =
      `intent://${deepPath}#Intent;scheme=zhihu;package=com.zhihu.android`
      + `;S.browser_fallback_url=${encodeURIComponent(url)};end`;
    try {
      await Linking.openURL(intent);
      return;
    } catch {
      // 知乎 App 未安装 → 回落到系统浏览器
    }
  }
  try {
    await Linking.openURL(url);
  } catch {
    // 无可处理该链接的应用时静默忽略
  }
}
