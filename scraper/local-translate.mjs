/**
 * local-translate.mjs — 本地 en-zh CTranslate2 服务的共用 HTTP 客户端。
 *
 * 服务由 /volume1/docker/en-zh-translate 独立部署。宿主机脚本默认走 localhost；
 * stories-api 容器会由 start-api.sh 注入 Docker 内网地址。
 */
export const LOCAL_TRANSLATE_MODEL = 'argos-en-zh-1.9';

export async function translateLocal(text, {
  endpoint = process.env.LOCAL_TRANSLATE_URL || 'http://127.0.0.1:8788/translate',
  timeoutMs = 60_000,
} = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source: 'en', target: 'zh' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail ?? detail.error ?? `本地翻译服务返回 ${response.status}`);
  }
  const result = await response.json();
  const zh = String(result.translatedText ?? '').replace(/\s*\n+\s*/g, ' ').trim();
  if (!zh) throw new Error('本地译文为空');
  return zh;
}

export function looksChinese(text) {
  const chars = String(text).replace(/\s/g, '');
  if (!chars) return false;
  const cjk = (chars.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return cjk / chars.length > 0.15;
}
