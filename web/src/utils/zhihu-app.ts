/*
 * 知乎 App 深链（deep link）工具。
 *
 * 手机上点击标题/「查看原文」时，把 zhihu.com 的 https 链接转成知乎 App
 * 的自定义 scheme 直接唤起 App，而不是打开网页。
 *
 * 【重要】深链必须写进 <a href>，不能用 JS location.href 跳：
 * Chrome 放行 JS 发起的 scheme 跳转，但 Edge / 部分浏览器会把它静默拦截
 * （实测 Edge Android 点击无反应）。href 是标准链接导航，全浏览器兼容。
 *
 *  - Android：href 用 intent:// 包装，Chrome 未装 App 时自动回落到原
 *    https 链接（S.browser_fallback_url）；其他浏览器（Edge 等）不认
 *    fallback 参数，由 JS 兜底计时器在 2s 后回落
 *  - iOS：href 用 zhihu:// scheme（已装则秒开）；未装时系统弹一次
 *    「无法打开页面」，JS 兜底计时器随后回落到 https 链接
 *  - 桌面端不干预，保持原 https 新标签页打开
 *
 * 深链映射（知乎 App 注册的 scheme，2026-09 实测数据里的四种链接全覆盖）：
 *   /question/{qid}              → zhihu://questions/{qid}
 *   /question/{qid}/answer/{aid} → zhihu://answers/{aid}
 *   /answer/{aid}                → zhihu://answers/{aid}
 *   zhuanlan.zhihu.com/p/{pid}   → zhihu://articles/{pid}
 *   /pin/{pid}                   → zhihu://pins/{pid}
 *   /people/{token}              → zhihu://people/{token}
 *
 * 注意：知乎 iOS 的 Universal Links（AASA）只注册了 /question/*、/p/*、
 * /pin/*、/people/*，没有 /answer/* —— 所以回答链接必须走 scheme 才能唤起 App。
 */

/** 从知乎 https 链接解析出 App 深链路径（如 `answers/123`）；非知乎链接返回 null */
export function toZhihuDeepPath(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const id = (i: number) => (/^\d+$/.test(seg[i] ?? '') ? seg[i] : null);

  if (host === 'zhihu.com') {
    if (seg[0] === 'question' && id(1)) {
      // /question/{qid}/answer/{aid} → 优先直接打开这条回答
      if (seg[2] === 'answer' && id(3)) return `answers/${seg[3]}`;
      return `questions/${seg[1]}`;
    }
    if (seg[0] === 'answer' && id(1)) return `answers/${seg[1]}`;
    if (seg[0] === 'pin' && id(1)) return `pins/${seg[1]}`;
    if (seg[0] === 'p' && id(1)) return `articles/${seg[1]}`;
    if (seg[0] === 'people' && seg[1]) return `people/${seg[1]}`;
  } else if (host === 'zhuanlan.zhihu.com') {
    if (seg[0] === 'p' && id(1)) return `articles/${seg[1]}`;
  }
  return null;
}

function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Android：intent:// 包装，未装 App 时 Chrome 自动跳 fallback_url */
function buildIntentUrl(url: string, deepPath: string): string {
  const fallback = encodeURIComponent(url);
  return `intent://${deepPath}#Intent;scheme=zhihu;package=com.zhihu.android;S.browser_fallback_url=${fallback};end`;
}

/**
 * JS 兜底：点击深链后 2s 内 App 没把页面切到后台（未装 App / 浏览器不认
 * intent fallback），就回落到原 https 链接。App 被唤起时 pagehide /
 * visibilitychange 会触发，计时器自动取消，不会误跳。
 */
function scheduleWebFallback(url: string): void {
  const startedAt = Date.now();
  const timer = window.setTimeout(() => {
    if (!document.hidden && Date.now() - startedAt < 3000) {
      window.location.href = url;
    }
  }, 2000);
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
  document.addEventListener(
    'visibilitychange',
    function onHide() {
      if (document.hidden) {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onHide);
      }
    },
    { once: true },
  );
}

export interface ZhihuAppLink {
  /** 渲染进 <a href>：移动端为深链（intent:// 或 zhihu://），桌面为原 https */
  href: string;
  /** 桌面端新标签打开；移动端深链必须当前页导航，返回 undefined */
  target?: '_blank';
  /** 移动端点击时启动"未被唤起则回落网页"的兜底计时器 */
  onClick?: () => void;
}

/**
 * 为知乎链接生成 <a> 的属性：移动端把深链放进 href（兼容 Edge 等浏览器），
 * 桌面 / 非知乎链接返回原始 https 新标签行为。
 */
export function zhihuAppLink(url: string): ZhihuAppLink {
  if (typeof window === 'undefined') return { href: url, target: '_blank' };
  const deepPath = toZhihuDeepPath(url);
  if (!deepPath) return { href: url, target: '_blank' };

  if (isAndroid()) {
    return { href: buildIntentUrl(url, deepPath), onClick: () => scheduleWebFallback(url) };
  }
  if (isIOS()) {
    return { href: `zhihu://${deepPath}`, onClick: () => scheduleWebFallback(url) };
  }
  return { href: url, target: '_blank' };
}
