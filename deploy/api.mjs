#!/usr/bin/env node
/**
 * stories 行为上报 API（零依赖，node:http）。
 *
 * 职责只有 I/O：收浏览器埋点 → 追加写 storage/events.jsonl；
 * 读 storage/profile.json → 吐画像摘要。所有重活（分析/排序/LLM）
 * 都由 scheduler 定时跑批（profile-engine / ranker），这里绝不调 LLM。
 *
 * 部署：docker 容器内运行（deploy/start-api.sh），与 stories-nginx 同网络，
 * 由 nginx 在 JWT 认证之后反代 /api/ → 本服务，因此这里不再做鉴权。
 * 本机调试：node deploy/api.mjs（默认 127.0.0.1:8787，可 PORT 覆盖）。
 *
 * 端点：
 *   POST /api/events   { events: [{kind,itemId,source,tags,author,title,eid,dwellMs?}] }
 *   GET  /api/profile  偏好层摘要（tag 权重 / 避雷 / 来源亲和）
 *   POST /api/likes    { likes: [{itemId,source,author,title,excerpt,url,cover,feed,tags,createdAt,likedAt}] }
 *   GET  /api/likes    全量收藏（likedAt 倒序，itemId 去重）——收藏夹的服务端备份，永不轮转
 *   GET  /api/health   存活探针
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
import { normalizeLikeInput, appendLikes, readAllLikes } from '../scraper/like-store.mjs';

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
  const url = (req.url ?? '').split('?')[0];

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
  } else {
    return json(res, 429, { ok: false, error: 'rate limited' });
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[api] listening on ${HOST}:${PORT}，storage: ${STORAGE_DIR}`);
});
