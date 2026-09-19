/**
 * github-http.mjs — GitHub 系抓取共用的 HTTP 工具。
 *
 * github.com / raw.githubusercontent.com / api.github.com 在部署机直连不通，
 * 统一走 clash 代理的 CONNECT 隧道（Node fetch 不认代理环境变量，自己挖隧道）：
 *   GITHUB_PROXY=http://127.0.0.1:7890   显式指定代理（缺省即此值）
 *   GITHUB_PROXY=direct                   强制直连
 *   未设 GITHUB_PROXY 时读标准环境变量 https_proxy，再缺省 clash。
 *   代理连接失败自动回落直连再试一次。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export const GITHUB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 25_000;
export const PROXY = (() => {
  const explicit = process.env.GITHUB_PROXY;
  if (explicit !== undefined) {
    return /^(direct|off|none|)$/.test(explicit.trim()) ? null : explicit.trim();
  }
  const std = process.env.https_proxy || process.env.HTTPS_PROXY;
  return std || 'http://127.0.0.1:7890';
})();

/** 通过 HTTP 代理 CONNECT 隧道发 HTTPS GET（timeoutMs 可按调用场景收紧，如 raw 探测） */
function requestViaProxy(targetUrl, headers, timeoutMs = TIMEOUT_MS) {
  const u = new URL(targetUrl);
  const p = new URL(PROXY);
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${u.hostname}:443`,
      headers: { Host: `${u.hostname}:443` },
    });
    connect.setTimeout(timeoutMs, () => connect.destroy(new Error('代理 CONNECT 超时')));
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
        return;
      }
      const req = https.request(
        targetUrl,
        {
          method: 'GET',
          headers,
          agent: false,
          createConnection: () => tls.connect({ socket, servername: u.hostname }),
        },
        resolve,
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      req.end();
    });
    connect.on('error', reject);
    connect.end();
  });
}

async function requestDirect(targetUrl, headers, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(targetUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404 || res.status === 410) throw new HttpError(res.status);
  if (res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 拉一个 URL 的文本：配置了代理先走代理，失败回落直连。404/410 抛 HttpError(status)。
 *  timeoutMs：raw 探测等「 healthy 时亚秒响应」的场景可以收紧到 10s，避免 clash 偶发卡顿白等。 */
export async function fetchText(url, headers = {}, timeoutMs = TIMEOUT_MS) {
  const h = { 'User-Agent': GITHUB_UA, Accept: 'text/html,application/json,text/plain,*/*', ...headers };
  if (PROXY) {
    try {
      const res = await requestViaProxy(url, h, timeoutMs);
      if (res.statusCode === 404 || res.statusCode === 410) throw new HttpError(res.statusCode);
      if (res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
      return await new Promise((resolve, reject) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      });
    } catch (e) {
      if (e instanceof HttpError) throw e; // 404 是有效答案（文件不存在），不要回落重试
      console.warn(`[WARN] 代理(${PROXY})抓取失败（${e.message}），回落直连重试`);
    }
  }
  return requestDirect(url, h, timeoutMs);
}

export async function fetchJson(url, headers = {}) {
  return JSON.parse(await fetchText(url, { ...headers, Accept: 'application/vnd.github+json' }));
}
