#!/usr/bin/env node
/**
 * stories 行为上报 API（零依赖，node:http）。
 *
 * 职责只有 I/O：收浏览器埋点 → 追加写 storage/events.jsonl；
 * 读 storage/profile.json → 吐画像摘要。所有重活（分析/排序/LLM）
 * 都由 scheduler 定时跑批（profile-engine / ranker），这里绝不调 LLM——
 * 唯一例外是 HN/GitHub 全文翻译：前端提交后台队列，完成后写回
 * storage/*-summaries.json 摘要库，永久复用。
 *
 * 部署：docker 容器内运行（deploy/start-api.sh），与 stories-nginx 同网络，
 * 由 nginx 在 JWT 认证之后反代 /api/ → 本服务，因此这里不再做鉴权。
 * 本机调试：node deploy/api.mjs（默认 127.0.0.1:8787，可 PORT 覆盖）。
 *
 * 端点：
 *   POST /api/events        { events: [{kind,itemId,source,tags,author,title,eid,dwellMs?}] }
 *   GET  /api/profile       偏好层摘要（tag 权重 / 避雷 / 来源亲和）
 *   POST /api/likes         { likes: [{itemId,source,author,title,excerpt,url,cover,feed,tags,createdAt,likedAt}] }
 *   GET  /api/likes         全量收藏（likedAt 倒序，itemId 去重）——收藏夹的服务端备份，永不轮转
 *   DELETE /api/likes/{id}  写入收藏删除墓碑（服务端备份与本地列表同步删除）
 *   POST /api/verdicts      { key, verdict }
 *   POST /api/hn/translate  { id } → 立即入队后台翻译（有缓存直接返回）
 *   GET  /api/hn/translate?id=… → 查询队列状态或已完成的译文
 *   POST /api/github/translate  { id } → 入队 README 翻译（有缓存直接返回）
 *   GET  /api/github/translate?id=… → 查询队列状态或已完成的译文
 *   GET  /api/health        存活探针
 */
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeEvent, rotateIfNeeded, appendEvents } from '../scraper/event-store.mjs';
import {
  loadVerdicts,
  saveVerdicts,
  normalizeVerdictInput,
  applyVerdict,
} from '../scraper/verdict-store.mjs';
import {
  normalizeLikeInput,
  appendLikes,
  appendLikeDeletes,
  readAllLikes,
} from '../scraper/like-store.mjs';
import { loadSummaryStore, saveSummaryStore } from '../scraper/summary-store.mjs';
import {
  fetchArticleText,
  translateArticleText,
  translateArticleTextLocally,
} from '../scraper/article-text.mjs';
import { MODEL } from '../scraper/zhipu.mjs';

const PORT = Number(process.env.PORT ?? 8787) || 8787;
const HOST = process.env.HOST ?? '0.0.0.0';
const STORAGE_DIR = process.env.STORAGE_DIR ?? path.resolve(import.meta.dirname, '..', 'scraper', 'storage');
const EVENTS_FILE = path.join(STORAGE_DIR, 'events.jsonl');
const PROFILE_FILE = path.join(STORAGE_DIR, 'profile.json');
const LIKES_FILE = path.join(STORAGE_DIR, 'likes.jsonl');

const MAX_BODY = 256 * 1024; // 单请求上限（批量埋点够用）
const MAX_BATCH = 50; // 单批事件数上限
const RATE_LIMIT = 120; // 请求/分钟/IP
const rate = new Map(); // ip → { count, resetAt }

// ---- HN 全文翻译（提交后台队列）----
const HN_HOST = 'news.ycombinator.com'; // 讨论页只有标题列表，没有可翻译正文
const LOCAL_TRANSLATE_URL = process.env.LOCAL_TRANSLATE_URL ?? '';
const LOCAL_TRANSLATE_MODEL = 'argos-en-zh-1.9';
const TRANSLATE_TIMEOUT_MS = 100_000; // 实测 glm-4-flash 翻 5000 字正文要 ~90s：单次尝试给足 100s（retries=0，最坏 <120s 压在 nginx 该端点超时内），失败由前端「点此重试」兜底
const MAX_CONCURRENT_TRANSLATIONS = 2; // 免费模型限流严重，并发翻多了全超时
const MAX_QUEUED_TRANSLATIONS = 20; // 后台任务上限，避免单个端点被刷爆后一直占着免费模型配额
const GITHUB_TRANSLATE_TIMEOUT_MS = Number(process.env.GITHUB_TRANSLATE_TIMEOUT_MS ?? 600_000) || 600_000;
const MAX_GITHUB_README_CHARS = 100_000;
const translating = new Map(); // id → { status, error? }；同一队列任务只翻一次
const translatingIds = new Set(); // 正在调用 LLM 的条目
const translationQueue = []; // 等待并发槽位的 HN 数字 id
const githubTranslating = new Map(); // id → { status, error? }
const githubTranslatingIds = new Set();
const githubTranslationQueue = [];

/** 翻译结果要避开长生命周期快照：保存前重读摘要库，防止覆盖调度器刚写入的新条目 */
async function saveHnTranslation(id, fields) {
  const store = await loadSummaryStore('hn');
  const entry = store.get(id);
  if (!entry) return false;
  Object.assign(entry, fields);
  await saveSummaryStore(store, { model: MODEL, source: 'hn' });
  return true;
}

/** 启动可运行的后台翻译；worker 不阻塞 HTTP 响应，任务状态留给 GET 查询 */
function startNextTranslation() {
  while (translatingIds.size < MAX_CONCURRENT_TRANSLATIONS && translationQueue.length > 0) {
    const id = translationQueue.shift();
    const job = translating.get(id);
    if (!job || translatingIds.has(id)) continue;

    translatingIds.add(id);
    job.status = 'translating';
    void (async () => {
      try {
        const store = await loadSummaryStore('hn');
        const entry = store.get(id);
        if (entry?.content_zh) {
          translating.delete(id);
          return;
        }
        if (!entry) throw new Error('条目不在摘要库（可能已过榜）');

        let content = entry.content || '';
        if (!content && entry.url && !entry.url.includes(HN_HOST)) {
          content = await fetchArticleText(entry.url); // 摘要时没抓到正文：点击时再试一次
        }
        if (!content) throw new Error('没有可翻译的正文（付费墙或 JS 渲染页）');
        let contentZh = '';
        let translateModel = MODEL;
        if (LOCAL_TRANSLATE_URL) {
          try {
            contentZh = await translateArticleTextLocally(content, LOCAL_TRANSLATE_URL, {
              timeoutMs: TRANSLATE_TIMEOUT_MS,
            });
            translateModel = LOCAL_TRANSLATE_MODEL;
          } catch (localError) {
            console.warn('[api] local translation failed, falling back to GLM:', localError.message);
          }
        }
        if (!contentZh) {
          const apiKey = process.env.ZHIPU_API_KEY;
          if (!apiKey) throw new Error('本地翻译不可用，且服务端未配置 ZHIPU_API_KEY');
          contentZh = await translateArticleText(content, apiKey, {
            timeoutMs: TRANSLATE_TIMEOUT_MS,
            retries: 0,
          });
        }
        await saveHnTranslation(id, {
          content_zh: contentZh,
          translated_at: new Date().toISOString(),
          translate_model: translateModel,
        });
        translating.delete(id);
      } catch (e) {
        const job = translating.get(id);
        if (job) {
          job.status = 'failed';
          job.error = e.message;
        }
        console.error('[api] HN translation failed:', id, e.message);
      } finally {
        translatingIds.delete(id);
        startNextTranslation();
      }
    })();
  }
}

function queueTranslation(id) {
  const existing = translating.get(id);
  if (existing && existing.status !== 'failed') {
    return existing.status === 'translating' ? 'translating' : 'queued';
  }
  // failed 任务只保留错误信息给前端查询，不再占用后台执行名额；
  // 否则 20 次付费墙/JS 渲染失败后，翻译按钮会一直误报队列已满。
  if (translationQueue.length + translatingIds.size >= MAX_QUEUED_TRANSLATIONS) return null;
  translating.set(id, { status: 'queued' });
  translationQueue.push(id);
  startNextTranslation();
  return translating.get(id).status;
}

/** GitHub README 只走本地推理；译文缓存进摘要库，下一轮 sync 自动注入 feed。 */
function startNextGithubTranslation() {
  while (githubTranslatingIds.size < 1 && githubTranslationQueue.length > 0) {
    const id = githubTranslationQueue.shift();
    const job = githubTranslating.get(id);
    if (!job || githubTranslatingIds.has(id)) continue;

    githubTranslatingIds.add(id);
    job.status = 'translating';
    void (async () => {
      try {
        const store = await loadSummaryStore('github');
        const entry = store.get(id);
        if (entry?.content_zh) {
          githubTranslating.delete(id);
          return;
        }
        if (!entry) throw new Error('仓库不在摘要库（可能已过榜）');

        const cacheFile = path.join(STORAGE_DIR, 'github-readme-cache.json');
        const cacheRaw = JSON.parse(await readFile(cacheFile, 'utf8'));
        const readme = cacheRaw.repos?.[id];
        if (!readme?.text) throw new Error('README 缓存不存在，等下一次 GitHub 摘要任务后重试');
        if (readme.lang === 'zh') {
          Object.assign(entry, {
            content_zh: readme.text,
            translated_at: new Date().toISOString(),
            translate_model: 'source-zh',
          });
        } else {
          if (!LOCAL_TRANSLATE_URL) throw new Error('服务端未配置本地翻译服务');
          const contentZh = await translateArticleTextLocally(
            readme.text.slice(0, MAX_GITHUB_README_CHARS),
            LOCAL_TRANSLATE_URL,
            { timeoutMs: GITHUB_TRANSLATE_TIMEOUT_MS },
          );
          Object.assign(entry, {
            content_zh: contentZh,
            translated_at: new Date().toISOString(),
            translate_model: LOCAL_TRANSLATE_MODEL,
          });
        }

        const latestStore = await loadSummaryStore('github');
        const latestEntry = latestStore.get(id);
        if (!latestEntry) throw new Error('仓库不在摘要库（可能已过榜）');
        Object.assign(latestEntry, {
          content_zh: entry.content_zh,
          translated_at: entry.translated_at,
          translate_model: entry.translate_model,
        });
        await saveSummaryStore(latestStore, { model: LOCAL_TRANSLATE_MODEL, source: 'github' });
        githubTranslating.delete(id);
      } catch (e) {
        const job = githubTranslating.get(id);
        if (job) {
          job.status = 'failed';
          job.error = e.message;
        }
        console.error('[api] GitHub README translation failed:', id, e.message);
      } finally {
        githubTranslatingIds.delete(id);
        startNextGithubTranslation();
      }
    })();
  }
}

function queueGithubTranslation(id) {
  const existing = githubTranslating.get(id);
  if (existing && existing.status !== 'failed') {
    return existing.status === 'translating' ? 'translating' : 'queued';
  }
  if (githubTranslationQueue.length + githubTranslatingIds.size >= 5) return null;
  githubTranslating.set(id, { status: 'queued' });
  githubTranslationQueue.push(id);
  startNextGithubTranslation();
  return githubTranslating.get(id).status;
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = rate.get(ip);
  if (!rec || now > rec.resetAt) {
    rate.set(ip, { count: 1, resetAt: now + 60_000 });
    if (rate.size > 10_000) rate.clear(); // 防表膨胀
    return false;
  }
  rec.count++;
  return rec.count > RATE_LIMIT;
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const requestUrl = new URL(req.url ?? '/', 'http://localhost');
  const url = requestUrl.pathname;

  if (url === '/api/health') {
    return json(res, 200, { ok: true, uptime: process.uptime() });
  }

  if (!rateLimited(ip)) {
    if (req.method === 'POST' && url === '/api/events') {
      try {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || '{}');
        const list = Array.isArray(parsed.events) ? parsed.events.slice(0, MAX_BATCH) : [];
        const now = Date.now();
        const valid = list
          .map((e) => normalizeEvent(e, { now }))
          .filter(Boolean);
        if (valid.length === 0) {
          return json(res, 400, { ok: false, error: 'no valid events' });
        }
        await mkdir(STORAGE_DIR, { recursive: true });
        const accepted = await appendEvents(valid, { eventsFile: EVENTS_FILE });
        rotateIfNeeded({ storageDir: STORAGE_DIR, eventsFile: EVENTS_FILE }).catch(() => {});
        return json(res, 200, { ok: true, accepted });
      } catch (e) {
        return json(res, e.message === 'body too large' ? 413 : 400, { ok: false, error: e.message });
      }
    }

    if (req.method === 'GET' && url === '/api/profile') {
      try {
        const profile = JSON.parse(await readFile(PROFILE_FILE, 'utf8'));
        const verdicts = await loadVerdicts();
        // 摘要 + 裁决状态（证据事件 id 不下发，只给计数）
        const verdictOf = (key) => verdicts.get(key)?.verdict ?? null;
        return json(res, 200, {
          ok: true,
          updatedAt: profile.updatedAt,
          stats: profile.stats ?? {},
          topTags: Object.entries(profile.tagWeights ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 30)
            .map(([tag, weight]) => ({
              tag,
              weight,
              verdict: verdictOf(`tag:${tag}`),
              evidenceCount: (profile.tagEvidence?.[tag] ?? []).length,
            })),
          dislikedTags: (profile.dislikedTags ?? []).map((tag) => ({
            tag,
            verdict: verdictOf(`dislike:${tag}`),
          })),
          authorAffinity: Object.entries(profile.authorAffinity ?? {})
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([author, weight]) => ({
              author,
              weight,
              verdict: verdictOf(`author:${author}`),
            })),
          sourceAffinity: profile.sourceAffinity ?? {},
          rejectedInterests: profile.rejectedInterests ?? [],
          rejectedAuthors: profile.rejectedAuthors ?? [],
          confirmedDislikes: profile.confirmedDislikes ?? [],
          portrait: profile.portrait ?? null,
        });
      } catch {
        return json(res, 200, {
          ok: true,
          updatedAt: null,
          stats: {},
          topTags: [],
          dislikedTags: [],
          authorAffinity: [],
          sourceAffinity: {},
          rejectedInterests: [],
          rejectedAuthors: [],
          confirmedDislikes: [],
          portrait: null,
        });
      }
    }

    if (req.method === 'POST' && url === '/api/likes') {
      try {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || '{}');
        const list = Array.isArray(parsed.likes) ? parsed.likes.slice(0, MAX_BATCH) : [];
        const now = Date.now();
        const valid = list.map((e) => normalizeLikeInput(e, { now })).filter(Boolean);
        if (valid.length === 0) {
          return json(res, 400, { ok: false, error: 'no valid likes' });
        }
        await mkdir(STORAGE_DIR, { recursive: true });
        const accepted = await appendLikes(valid, { likesFile: LIKES_FILE });
        // 与 events 不同：likes.jsonl 永不轮转（收藏是档案，见 like-store.mjs 头注释）
        return json(res, 200, { ok: true, accepted });
      } catch (e) {
        return json(res, e.message === 'body too large' ? 413 : 400, { ok: false, error: e.message });
      }
    }

    if (req.method === 'GET' && url === '/api/likes') {
      try {
        const likes = await readAllLikes({ likesFile: LIKES_FILE });
        return json(res, 200, { ok: true, likes });
      } catch {
        return json(res, 200, { ok: true, likes: [] });
      }
    }

    if (req.method === 'DELETE' && url.startsWith('/api/likes/')) {
      try {
        const itemId = decodeURIComponent(url.slice('/api/likes/'.length));
        await mkdir(STORAGE_DIR, { recursive: true });
        const deleted = await appendLikeDeletes([itemId], { likesFile: LIKES_FILE });
        if (deleted === 0) return json(res, 400, { ok: false, error: 'invalid item id' });
        return json(res, 200, { ok: true, deleted });
      } catch (e) {
        console.error('[api] delete like failed:', e);
        return json(res, 500, { ok: false, error: 'delete failed' });
      }
    }

    if (req.method === 'POST' && url === '/api/verdicts') {
      try {
        const raw = await readBody(req);
        const parsed = JSON.parse(raw || '{}');
        const input = normalizeVerdictInput(parsed);
        if (!input) return json(res, 400, { ok: false, error: 'invalid key or verdict' });
        const verdicts = await loadVerdicts();
        applyVerdict(verdicts, input.key, input.verdict);
        await saveVerdicts(verdicts);
        // 裁决只改覆盖层；画像由下一次 profile/rank 批处理应用（秒级成本，不阻塞响应）
        return json(res, 200, { ok: true, key: input.key, verdict: input.verdict });
      } catch (e) {
        return json(res, e.message === 'body too large' ? 413 : 400, { ok: false, error: e.message });
      }
    }

    // HN 全文翻译：前端「翻译全文」按钮只提交任务。有缓存秒回；没缓存交给后台队列
    // （摘要在批处理里已备好原文 entry.content，这里通常只需翻译这一步）。
    if (req.method === 'POST' && url === '/api/hn/translate') {
      let id = '';
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}');
        id = String(parsed.id ?? '').replace(/^hn:/, ''); // 兼容全局 id（hn:{rawId}）
      } catch (e) {
        return json(res, e.message === 'body too large' ? 413 : 400, { ok: false, error: e.message });
      }
      if (!/^\d+$/.test(id)) return json(res, 400, { ok: false, error: 'invalid id' });

      const store = await loadSummaryStore('hn'); // 每次现读：调度器也在写这份文件
      const entry = store.get(id);
      if (!entry) return json(res, 404, { ok: false, error: '条目不在摘要库（可能已过榜）' });
      if (entry.content_zh) {
        return json(res, 200, { ok: true, cached: true, title_zh: entry.title_zh ?? '', content_zh: entry.content_zh });
      }

      const status = queueTranslation(id);
      if (!status) {
        return json(res, 429, { ok: false, error: '翻译队列已满，稍后再试' });
      }
      return json(res, 202, { ok: true, status });
    }

    // APK 在请求入队后可刷新状态；卡片重挂载时据此恢复“排队/翻译中”并取回完成结果
    if (req.method === 'GET' && url === '/api/hn/translate') {
      const id = requestUrl.searchParams.get('id') ?? '';
      if (!/^\d+$/.test(id)) return json(res, 400, { ok: false, error: 'invalid id' });

      const store = await loadSummaryStore('hn');
      const entry = store.get(id);
      if (entry?.content_zh) {
        translating.delete(id);
        return json(res, 200, {
          ok: true,
          status: 'done',
          title_zh: entry.title_zh ?? '',
          content_zh: entry.content_zh,
        });
      }
      if (!entry) return json(res, 404, { ok: false, error: '条目不在摘要库（可能已过榜）' });

      const job = translating.get(id);
      if (!job) return json(res, 404, { ok: false, status: 'missing', error: '翻译任务不存在（可能已重启）' });
      if (job.status === 'failed') {
        return json(res, 200, { ok: false, status: 'failed', error: `翻译失败：${job.error ?? '未知错误'}` });
      }
      return json(res, 202, { ok: true, status: job.status });
    }

    // GitHub README：展开卡片时自动入队。长 README 由后端慢慢翻，前端只轮询状态。
    if (req.method === 'POST' && url === '/api/github/translate') {
      let id = '';
      try {
        const parsed = JSON.parse((await readBody(req)) || '{}');
        id = String(parsed.id ?? '').replace(/^github:/, '');
      } catch (e) {
        return json(res, e.message === 'body too large' ? 413 : 400, { ok: false, error: e.message });
      }
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) {
        return json(res, 400, { ok: false, error: 'invalid repository id' });
      }

      const store = await loadSummaryStore('github');
      const entry = store.get(id);
      if (entry?.content_zh) {
        return json(res, 200, { ok: true, cached: true, content_zh: entry.content_zh });
      }
      if (!entry) return json(res, 404, { ok: false, error: '仓库不在摘要库（可能已过榜）' });

      const status = queueGithubTranslation(id);
      if (!status) return json(res, 429, { ok: false, error: '翻译队列已满，稍后再试' });
      return json(res, 202, { ok: true, status });
    }

    if (req.method === 'GET' && url === '/api/github/translate') {
      const id = requestUrl.searchParams.get('id') ?? '';
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) {
        return json(res, 400, { ok: false, error: 'invalid repository id' });
      }

      const store = await loadSummaryStore('github');
      const entry = store.get(id);
      if (entry?.content_zh) {
        githubTranslating.delete(id);
        return json(res, 200, { ok: true, status: 'done', content_zh: entry.content_zh });
      }
      if (!entry) return json(res, 404, { ok: false, status: 'missing', error: '仓库不在摘要库（可能已过榜）' });

      const job = githubTranslating.get(id);
      if (!job) return json(res, 404, { ok: false, status: 'missing', error: '翻译任务不存在（可能已重启）' });
      if (job.status === 'failed') {
        return json(res, 200, { ok: false, status: 'failed', error: `翻译失败：${job.error ?? '未知错误'}` });
      }
      return json(res, 202, { ok: true, status: job.status });
    }
  } else {
    return json(res, 429, { ok: false, error: 'rate limited' });
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[api] listening on ${HOST}:${PORT}，storage: ${STORAGE_DIR}`);
});
