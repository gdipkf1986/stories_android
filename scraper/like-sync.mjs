#!/usr/bin/env node
/**
 * 平台回写：把「我喜欢」收藏夹里还没同步过的条目，在对应平台上代用户点一次赞/赞同。
 *
 * 数据流：
 *   APK 点「喜欢」/点开原文 → /api/likes → scraper/storage/likes.jsonl（永不轮转）
 *     → 本脚本读全量、对照 storage/like-sync-state.json 挑出没回写过条目
 *     → 用 scraper/storage/{zhihu,bilibili}-state.json 里的登录 cookie 调平台 web API
 *     → 逐条标记 ok / skip / parked
 *
 * 平台动作映射（URL 是唯一权威，itemId 只用来查状态）：
 *   zhihu   /question/{qid}/answer/{aid} → 赞同回答 POST /api/v4/answers/{aid}/voters
 *           zhuanlan.zhihu.com/p/{pid}   → 点赞文章 POST /api/v4/articles/{pid}/voters
 *           /question/{qid}（热榜形态）   → skip：问题页没有「赞同」对象，不代用户关注
 *   bilibili /video/BVxxx               → 点赞视频 POST /x/web-interface/archive/like
 *           （BV→av 由 view 接口换算并缓存在状态文件里）
 *   github  → skip：无统一登录态，暂不代星标（将来接 PAT 可加 PUT /user/starred）
 *
 * 安全阀（这是非官方 API，克制优先）：
 *   - 每平台每轮最多 PER_PLATFORM_CAP 条，两次调用间隔随机延迟
 *   - 认证失效/风控（4xx、-101/-111/-412）→ 本轮停该平台并明确提示重新扫码
 *   - 同一条连续失败 RETRY_MAX 次后 parked 不再重试；换新登录态（cookie 指纹变化）
 *     自动解锁 parked 重试；--retry 可手动清 parked
 *   - --dry-run 只打印将做什么，不发任何请求
 *
 * 用法:
 *   npm run likes:sync                     # 同步一次（调度器每轮抓取前也会自动跑）
 *   npm run likes:sync -- --dry-run        # 演练：只打印映射与动作
 *   npm run likes:sync -- --status         # 只看状态统计
 *   npm run likes:sync -- --retry          # 清掉 parked，下轮全部重试
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readAllLikes } from './like-store.mjs';

const SCRAPER_DIR = import.meta.dirname;
const STORAGE_DIR = path.join(SCRAPER_DIR, 'storage');
const LIKES_FILE = path.join(STORAGE_DIR, 'likes.jsonl');
const STATE_FILE = path.join(STORAGE_DIR, 'like-sync-state.json');
const ZHIHU_STATE_FILE = path.join(STORAGE_DIR, 'zhihu-state.json');
const BILIBILI_STATE_FILE = path.join(STORAGE_DIR, 'bilibili-state.json');

const PER_PLATFORM_CAP = 20; // 每轮每平台最多回写条数（冷启动积压分摊到多轮，避免 burst）
const RETRY_MAX = 5; // 同一条最多尝试次数，超过即 parked（防永久失败项每轮刷屏）
const CALL_DELAY_MS = [2500, 6000]; // 平台调用之间的随机延迟区间（克制，防风控）
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class AuthError extends Error {} // 登录态失效/风控：本轮停该平台
class RateLimitError extends Error {} // 明确限流：本轮停该平台，下次再试

// ---------------------------------------------------------------------------
// URL → 平台目标
// ---------------------------------------------------------------------------

/** 知乎 URL 解析：回答 / 专栏文章 / 问题（不可赞）。解析不了返回 null */
export function resolveZhihuTarget(url) {
  const m = String(url ?? '').match(
    /^https?:\/\/(?:www\.)?(zhuanlan\.)?zhihu\.com\/([^\s?#]+)/i,
  );
  if (!m) return null;
  const seg = m[2].split('/').filter(Boolean);
  const numeric = (i) => (/^\d+$/.test(seg[i] ?? '') ? seg[i] : null);
  if (m[1]) {
    // zhuanlan.zhihu.com/p/{pid}
    if (seg[0] === 'p' && numeric(1)) return { kind: 'article', id: seg[1] };
    return null;
  }
  // 移动端专栏形态 www.zhihu.com/tardis/zm/art/{pid}，pid 与 /p/{pid} 同为文章 id
  if (seg[0] === 'tardis' && seg[1] === 'zm' && seg[2] === 'art' && numeric(3)) {
    return { kind: 'article', id: seg[3] };
  }
  if (seg[0] === 'question' && numeric(1)) {
    if (seg[2] === 'answer' && numeric(3)) return { kind: 'answer', id: seg[3], qid: seg[1] };
    return { kind: 'question', id: seg[1] };
  }
  if (seg[0] === 'answer' && numeric(1)) return { kind: 'answer', id: seg[1] };
  return null;
}

/** B站 URL 解析：BV 号优先，老式 av 号也认。解析不了返回 null */
export function resolveBilibiliTarget(url) {
  const m = String(url ?? '').match(
    /^https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]+|av\d+)/i,
  );
  if (!m) return null;
  const ref = m[1];
  return ref.toLowerCase().startsWith('av')
    ? { kind: 'video', aid: Number(ref.slice(2)), bvid: null }
    : { kind: 'video', aid: null, bvid: ref };
}

/** 某条收藏能映射出的平台动作；null = 平台不支持（github 等） */
export function resolveTarget(like) {
  if (like.source === 'zhihu') {
    const t = resolveZhihuTarget(like.url);
    return t && t.kind === 'question' ? { platform: 'zhihu', skip: 'question' } : t ? { platform: 'zhihu', ...t } : null;
  }
  if (like.source === 'bilibili') {
    const t = resolveBilibiliTarget(like.url);
    return t ? { platform: 'bilibili', ...t } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 登录态（复用抓取器的 Playwright storageState，不另设凭据体系）
// ---------------------------------------------------------------------------

/** 从 Playwright storageState 里抽出指定域名 cookie，拼成 Cookie 头；缺关键 cookie 抛 AuthError */
function loadCookieHeader(stateFile, domainIncludes, required) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    throw new AuthError(`登录态文件不可读: ${path.basename(stateFile)}`);
  }
  const cookies = (st.cookies ?? []).filter((c) => String(c.domain ?? '').includes(domainIncludes));
  const byName = new Map(cookies.map((c) => [c.name, c.value]));
  const missing = required.filter((n) => !byName.get(n));
  if (missing.length > 0) {
    throw new AuthError(`登录态缺 ${missing.join('/')} cookie（未登录或登录态过期）`);
  }
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  // 指纹 = 关键登录 cookie 的哈希前 8 位：换号/重登后能识别并解锁 parked
  const fp = createHash('sha256')
    .update(required.map((n) => byName.get(n)).join('|'))
    .digest('hex')
    .slice(0, 8);
  return { header, fingerprint: fp };
}

function zhihuCookies() {
  return loadCookieHeader(ZHIHU_STATE_FILE, 'zhihu.com', ['z_c0', 'd_c0']);
}

function bilibiliCookies() {
  return loadCookieHeader(BILIBILI_STATE_FILE, 'bilibili.com', ['SESSDATA', 'bili_jct']);
}

// ---------------------------------------------------------------------------
// 平台调用（全部非官方 API，响应体一律记进日志方便排障）
// ---------------------------------------------------------------------------

async function httpPost(url, { headers = {}, body }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'user-agent': UA, ...headers },
    body,
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, text: text.slice(0, 400) };
}

/** 知乎赞同/点赞：先试 web v4 voters 接口，403/404 时用老接口兜底一次 */
async function zhihuLike(target, cookieHeader) {
  const headers = {
    cookie: cookieHeader,
    'content-type': 'application/json',
    'x-requested-with': 'fetch',
    referer: 'https://www.zhihu.com/',
  };
  const isAnswer = target.kind === 'answer';
  const primary = isAnswer
    ? `https://www.zhihu.com/api/v4/answers/${target.id}/voters`
    : `https://www.zhihu.com/api/v4/articles/${target.id}/voters`;
  let r = await httpPost(primary, { headers, body: '{}' });
  if (r.status === 403 || r.status === 404) {
    // v4 接口拒了（签名策略/接口变更）→ 老接口再试一次
    const fallback = isAnswer
      ? `https://api.zhihu.com/answers/${target.id}/voters`
      : `https://zhuanlan.zhihu.com/api/posts/${target.id}/vote`;
    r = await httpPost(fallback, {
      headers,
      body: isAnswer ? undefined : '{"type":"up"}',
    });
  }
  if (r.status === 401 || r.status === 403) {
    throw new AuthError(`知乎拒绝 (${r.status})：${r.text}`);
  }
  if (r.status === 429) {
    throw new RateLimitError(`知乎限流 (429)：${r.text}`);
  }
  if (r.status >= 200 && r.status < 300) return `HTTP ${r.status} ${r.text || '(空)'}`;
  throw new Error(`知乎未预期的响应 (${r.status})：${r.text}`);
}

/** BV → av 换算（view 接口无需登录），结果缓存在状态文件 */
async function bilibiliResolveAid(target, bv2av) {
  if (target.aid) return target.aid;
  const cached = bv2av[target.bvid];
  if (cached) return cached;
  const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${target.bvid}`, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
  });
  const body = await res.json().catch(() => ({}));
  const aid = body?.data?.aid;
  if (!Number.isFinite(aid)) {
    throw new Error(`BV→av 换算失败 (HTTP ${res.status}, code ${body?.code}): ${target.bvid}`);
  }
  bv2av[target.bvid] = aid;
  return aid;
}

/** B站点赞：form 表单 + bili_jct 做 csrf；Referer 必须像浏览器 */
async function bilibiliLike(target, cookieHeader, bv2av) {
  const jct = /bili_jct=([^;]+)/.exec(cookieHeader)?.[1];
  const aid = await bilibiliResolveAid(target, bv2av);
  const r = await httpPost('https://api.bilibili.com/x/web-interface/archive/like', {
    headers: {
      cookie: cookieHeader,
      'content-type': 'application/x-www-form-urlencoded',
      referer: `https://www.bilibili.com/video/${target.bvid ?? ''}`.trim(),
      origin: 'https://www.bilibili.com',
    },
    body: new URLSearchParams({ aid: String(aid), like: '1', csrf: jct ?? '' }).toString(),
  });
  let body = {};
  try {
    body = JSON.parse(r.text);
  } catch {
    /* 保持空对象，下面按原文日志 */
  }
  const code = body.code;
  if (code === 0) return `code 0 (aid ${aid})`;
  if (code === -101) throw new AuthError(`B站未登录 (code -101)：${r.text}`);
  if (code === -111) throw new AuthError(`B站 csrf 校验失败 (code -111)：${r.text}`);
  if (code === -412 || r.status === 412) throw new RateLimitError(`B站风控拦截 (code ${code ?? r.status})：${r.text}`);
  if (code === -799) throw new RateLimitError(`B站请求过快 (code -799)：${r.text}`);
  throw new Error(`B站未预期的响应 (HTTP ${r.status}, code ${code})：${r.text}`);
}

// ---------------------------------------------------------------------------
// 状态文件 + 主流程
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { version: 1, fingerprints: {}, bv2av: {}, items: {}, ...st };
  } catch {
    return { version: 1, fingerprints: {}, bv2av: {}, items: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const sleepMs = () =>
  sleep(CALL_DELAY_MS[0] + Math.random() * (CALL_DELAY_MS[1] - CALL_DELAY_MS[0]));

/** 主入口。返回 { ok, skipped, failed, parked, notes } 供调度器写日志 */
export async function runSync({ dryRun = false, clearParked = false } = {}) {
  const state = loadState();
  const likes = (await readAllLikes({ likesFile: LIKES_FILE })).reverse(); // 旧收藏先补
  const result = { ok: 0, skipped: 0, failed: 0, parked: 0, pending: 0, notes: [] };
  const note = (s) => result.notes.push(s);

  if (clearParked) {
    let n = 0;
    for (const it of Object.values(state.items)) {
      if (it.status === 'parked') {
        it.status = 'retry';
        n++;
      }
    }
    note(`已清 parked 标记 ${n} 条，下轮全部重试`);
  }

  if (likes.length === 0) return result;

  // cookie 指纹对不上（重登/换号）→ 解锁该平台 parked 项重新尝试
  const fingerprints = {};
  const cookies = {};
  for (const [platform, loader, file] of [
    ['zhihu', zhihuCookies, ZHIHU_STATE_FILE],
    ['bilibili', bilibiliCookies, BILIBILI_STATE_FILE],
  ]) {
    if (!fs.existsSync(file)) continue;
    try {
      const c = loader();
      cookies[platform] = c.header;
      fingerprints[platform] = c.fingerprint;
    } catch (e) {
      note(`${platform === 'zhihu' ? '知乎' : 'B站'}登录态不可用：${e.message}（npm run scrape:login${platform === 'bilibili' ? ':bilibili' : ''} 重新扫码）`);
    }
    if (
      state.fingerprints[platform] &&
      fingerprints[platform] &&
      state.fingerprints[platform] !== fingerprints[platform]
    ) {
      let n = 0;
      for (const [, it] of Object.entries(state.items)) {
        if (it.platform === platform && it.status === 'parked') {
          it.status = 'retry';
          delete it.attempts;
          n++;
        }
      }
      if (n > 0) note(`检测到${platform === 'zhihu' ? '知乎' : 'B站'}登录态更新，解锁 parked ${n} 条重试`);
    }
    if (fingerprints[platform]) state.fingerprints[platform] = fingerprints[platform];
  }

  // 每平台独立配额 + 独立「停摆」开关（认证失败/风控时只停自己）
  const quota = { zhihu: PER_PLATFORM_CAP, bilibili: PER_PLATFORM_CAP };
  const halted = {};
  const halt = (platform, reason) => {
    if (!halted[platform]) {
      halted[platform] = reason;
      note(`${platform === 'zhihu' ? '知乎' : 'B站'}本轮停止回写：${reason}`);
    }
  };

  for (const like of likes) {
    const itemId = like.itemId;
    const prev = state.items[itemId];
    if (prev?.status === 'ok' || prev?.status === 'skip') continue;
    if (prev?.status === 'parked') {
      result.parked++;
      continue;
    }

    const target = resolveTarget(like);
    if (!target || target.skip) {
      state.items[itemId] = {
        platform: target?.platform ?? like.source,
        status: 'skip',
        reason: target?.skip ? `问题页没有「赞同」对象，不代操作` : `平台暂不支持回写`,
        at: Date.now(),
      };
      result.skipped++;
      continue;
    }
    const { platform } = target;
    const label = platform === 'zhihu' ? '知乎' : 'B站';

    if (dryRun) {
      note(
        `[dry] ${itemId} → ${label}${target.kind === 'answer' ? '赞同回答 ' : target.kind === 'article' ? '点赞文章 ' : '点赞视频 '}${target.id ?? target.bvid}（${like.title.slice(0, 30)}…）`,
      );
      result.ok++;
      continue;
    }

    if (halted[platform] || !cookies[platform] || quota[platform] <= 0) {
      if (!halted[platform] && !cookies[platform]) {
        halt(platform, '登录态不可用（见上方提示）');
      } else if (quota[platform] <= 0 && !halted[platform]) {
        halt(platform, `本轮配额用完（${PER_PLATFORM_CAP} 条）`);
      }
      result.pending++;
      continue;
    }

    const attempts = (prev?.attempts ?? 0) + 1;
    try {
      const detail =
        platform === 'zhihu'
          ? await zhihuLike(target, cookies[platform])
          : await bilibiliLike(target, cookies[platform], state.bv2av);
      state.items[itemId] = { platform, status: 'ok', detail: detail.slice(0, 120), at: Date.now(), attempts };
      result.ok++;
      note(`✓ ${itemId} → ${label}已点赞（${like.title.slice(0, 30)}…）`);
    } catch (e) {
      const msg = String(e.message ?? e).slice(0, 200);
      if (e instanceof AuthError || e instanceof RateLimitError) {
        halt(platform, msg);
        // 条目保持 retry：本轮平台停摆与个别条目失败无关，下轮（重新登录后）接着补
        state.items[itemId] = { platform, status: 'retry', attempts, lastError: msg, at: Date.now() };
        result.failed++;
      } else {
        const parked = attempts >= RETRY_MAX;
        state.items[itemId] = {
          platform,
          status: parked ? 'parked' : 'retry',
          attempts,
          lastError: msg,
          at: Date.now(),
        };
        if (parked) result.parked++;
        else result.failed++;
        note(`✗ ${itemId} → ${label}${parked ? `连续失败 ${attempts} 次，parked` : '失败，下轮重试'}：${msg}`);
      }
    }
    await sleepMs();
    if ((result.ok + result.failed) % 5 === 0) saveState(state); // 中途落盘，崩了不整轮重做
  }

  if (!dryRun) saveState(state); // dry-run 只看不动：状态文件一个字节都不写
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const clearParked = process.argv.includes('--retry');
  if (process.argv.includes('--status')) {
    const state = loadState();
    const counts = {};
    for (const it of Object.values(state.items)) counts[it.status] = (counts[it.status] ?? 0) + 1;
    console.log(
      `like-sync 状态：${JSON.stringify(counts)}；登录态指纹 ${JSON.stringify(state.fingerprints)}；BV 缓存 ${Object.keys(state.bv2av).length} 条`,
    );
    return;
  }
  runSync({ dryRun, clearParked })
    .then((r) => {
      for (const n of r.notes) console.log(n);
      const tail = dryRun
        ? `[dry-run] 将回写 ${r.ok} 条、跳过 ${r.skipped} 条（未发任何请求）`
        : `同步完成：成功 ${r.ok}、跳过 ${r.skipped}、失败 ${r.failed}、parked ${r.parked}、待下轮 ${r.pending}`;
      console.log(tail);
      if (!dryRun && r.failed > 0) process.exitCode = 1; // 调度器日志里醒目一点，但不影响其他链路
    })
    .catch((e) => {
      console.error(`like-sync 异常：${e.message}`);
      process.exitCode = 1;
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
