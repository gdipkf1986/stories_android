#!/usr/bin/env node
/**
 * 偏好层（画像）引擎：scraper/storage/profile.json
 *
 * 从行为事件（storage/events.jsonl）全量重算结构化偏好——纯确定性代码，
 * 不花任何 LLM 成本。LLM 人格画像（soul.json，P3）只在"显著变化"时重建，
 * 且只做展示与探针素材，不参与排序（结构化层才是排序的心脏）。
 *
 * 数据源无关：只消费事件里的 source/tags 字段，新数据源零改造自动生效。
 *
 * 合并/衰减规则（校准值借鉴 OpenBiliClaw）：
 *   - 每条事件贡献 weight × 0.9^(周龄)，同 tag 累加后 clamp 到 [0,1]
 *   - 低于 0.05 的 tag 丢弃（避免陈旧兴趣污染排序）
 *   - dislike 负向累积进 dislikedTags（近因排序，容量 128），不与正向混算
 *   - 单条事件只是证据；画像在批层级整体推进（本引擎每次运行即一批）
 *
 * 用法: npm run profile   （幂等，可反复运行）
 */
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { STRUCTURAL_TAGS } from './sources.node.mjs';
import {
  readAllEvents,
  rotateIfNeeded,
  EVENT_KINDS,
} from './event-store.mjs';
import { loadVerdicts } from './verdict-store.mjs';

const STORAGE_DIR = path.resolve(import.meta.dirname, 'storage');
const EVENTS_FILE = path.join(STORAGE_DIR, 'events.jsonl');
const PROFILE_FILE = path.join(STORAGE_DIR, 'profile.json');

const DECAY_PER_WEEK = 0.9; // 周衰减因子
const MIN_WEIGHT = 0.05; // 低于它丢弃
const WEIGHT_CAP = 1.0;
const DISLIKED_CAP = 128; // 避雷容量（近因排序，最旧的滑出）
const EVIDENCE_CAP = 20; // 每个 tag 保留的最近证据事件 id
const AUTHORS_CAP = 64;
const clamp01 = (v) => Math.max(0, Math.min(WEIGHT_CAP, v));

/** 正向事件在时间上的贡献：半衰期 1 周 */
function decayed(weight, eventTime, now) {
  const weeks = Math.max(0, (now - eventTime) / (7 * 24 * 3600 * 1000));
  return weight * DECAY_PER_WEEK ** weeks;
}

function buildProfile(events, now) {
  /** tag → { weight, evidence: Map<eid, t>, pos, neg } */
  const tags = new Map();
  const disliked = new Map(); // tag → 最近一次 dislike 时间（近因排序用）
  const sources = new Map();
  const authors = new Map();
  const hours = Array.from({ length: 24 }, () => 0);
  const byKind = {};

  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const t = e.t ?? now;

    if (e.kind === 'dislike') {
      // 负向只进避雷与负证据，绝不贡献正向权重。
      // 结构标签（视频/热榜这类类型标签）跳过：对单条内容的负反馈一旦记到
      // 类型头上，就等于避雷整个来源/子板块的全部条目
      for (const tag of e.tags ?? []) {
        if (STRUCTURAL_TAGS.has(tag)) continue;
        disliked.set(tag, Math.max(disliked.get(tag) ?? 0, t));
        const rec = tags.get(tag) ?? { weight: 0, evidence: new Map(), pos: 0, neg: 0 };
        rec.neg += 1;
        if (e.eid) rec.evidence.set(e.eid, t);
        tags.set(tag, rec);
      }
      continue;
    }

    const w = decayed(e.weight ?? EVENT_KINDS[e.kind] ?? 0, t, now);
    if (w > 0) {
      // 结构标签同样不进正向权重：旧版客户端的事件 payload 仍携带「视频」这类
      // 类型标签，计入会让全源条目均匀吃相关性、稀释真实兴趣的区分度
      for (const tag of e.tags ?? []) {
        if (STRUCTURAL_TAGS.has(tag)) continue;
        const rec = tags.get(tag) ?? { weight: 0, evidence: new Map(), pos: 0, neg: 0 };
        rec.weight = clamp01(rec.weight + w);
        rec.pos += 1;
        if (e.eid) rec.evidence.set(e.eid, t);
        tags.set(tag, rec);
      }
      const src = e.source ?? 'unknown';
      sources.set(src, clamp01((sources.get(src) ?? 0) + w * 0.5)); // 来源亲和衰减得更慢些
      if (e.author) authors.set(e.author, clamp01((authors.get(e.author) ?? 0) + w));
      hours[new Date(t).getHours()] += 1;
    }
  }

  // 避雷列表：近因排序，截到容量上限
  const dislikedTags = [...disliked.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DISLIKED_CAP)
    .map(([tag, t]) => ({ tag, dislikedAt: t }));

  // tag 权重表：丢弃低权重与纯负向噪音
  const tagWeights = {};
  const tagEvidence = {};
  for (const [tag, rec] of tags) {
    if (rec.pos === 0 && rec.neg === 0) continue;
    if (rec.weight < MIN_WEIGHT && !disliked.has(tag)) continue;
    tagWeights[tag] = Number(rec.weight.toFixed(3));
    const evidence = [...rec.evidence.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, EVIDENCE_CAP)
      .map(([eid]) => eid);
    if (evidence.length > 0) tagEvidence[tag] = evidence;
  }

  const topTags = Object.fromEntries(
    Object.entries(tagWeights)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 64),
  );

  return {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    tagWeights: topTags,
    tagEvidence,
    dislikedTags: dislikedTags.map((d) => d.tag),
    sourceAffinity: Object.fromEntries(
      [...sources.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Number(v.toFixed(3))])),
    authorAffinity: Object.fromEntries(
      [...authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, AUTHORS_CAP).map(([k, v]) => [k, Number(v.toFixed(3))])),
    timePatterns: { hourHistogram: hours },
    stats: {
      totalEvents: events.length,
      byKind,
      firstAt: events.length > 0 ? new Date(events[0].t ?? now).toISOString() : null,
      lastAt: events.length > 0 ? new Date(events[events.length - 1].t ?? now).toISOString() : null,
    },
    // P3 钩子：soul.json（LLM 人格画像）由此标记触发，低频、只做展示与探针
    portrait: null,
    portraitRebuildDue: false,
  };
}

/**
 * "显著变化"检测（P3 画像重建的触发条件，校准借鉴 OpenBiliClaw）：
 * 只看权重 ≥0.6 的高权重 tag；集合增删 ≥2、单 tag 权重漂移 ≥0.2、
 * 或新增避雷，才算显著——防止日常波动反复重写人格描述。
 */
function detectSignificantChange(prev, next) {
  if (!prev) return { significant: false, reasons: [] };
  const top = (p) =>
    new Set(Object.entries(p.tagWeights ?? {}).filter(([, w]) => w >= 0.6).map(([t]) => t));
  const prevTop = top(prev);
  const nextTop = top(next);
  const added = [...nextTop].filter((t) => !prevTop.has(t));
  const removed = [...prevTop].filter((t) => !nextTop.has(t));
  const reasons = [];
  if (added.length + removed.length >= 2) {
    reasons.push(`高权重兴趣增删 ${added.length + removed.length} 个（+${added.join('/') || '无'} −${removed.join('/') || '无'}）`);
  }
  for (const [tag, w] of Object.entries(next.tagWeights)) {
    const old = prev.tagWeights?.[tag];
    if (old !== undefined && Math.abs(w - old) >= 0.2) {
      reasons.push(`「${tag}」权重漂移 ${old.toFixed(2)}→${w.toFixed(2)}`);
      break;
    }
  }
  const newDisliked = (next.dislikedTags ?? []).filter((t) => !(prev.dislikedTags ?? []).includes(t));
  if (newDisliked.length > 0) reasons.push(`新增避雷：${newDisliked.slice(0, 3).join('、')}`);
  return { significant: reasons.length > 0, reasons };
}

/**
 * 用户裁决覆盖层：引擎每次全量重算后叠加（裁决独立持久化在
 * profile-verdicts.json，重建永不覆盖——OpenBiliClaw overrides 同款思路）。
 *   tag 确认 → 权重托底 0.75（防衰减漂移）；tag 反对 → 清零并移入 rejectedInterests
 *   避雷反对 → 移出 dislikedTags；避雷确认 → 保持并标记 confirmedDislikes
 *   作者确认 → 亲和托底 0.5；作者反对 → 清零并移入 rejectedAuthors（排序直接排除）
 */
function applyVerdicts(profile, verdicts) {
  profile.rejectedInterests = profile.rejectedInterests ?? [];
  profile.confirmedDislikes = profile.confirmedDislikes ?? [];
  profile.rejectedAuthors = profile.rejectedAuthors ?? [];
  if (verdicts.size === 0) return profile;

  const CONFIRMED_FLOOR = 0.75;
  const AUTHOR_FLOOR = 0.5;

  for (const [key, { verdict }] of verdicts) {
    const colon = key.indexOf(':');
    const type = key.slice(0, colon);
    const name = key.slice(colon + 1);
    if (verdict === 'none') continue;

    if (type === 'tag') {
      if (verdict === 'confirmed') {
        if (name in profile.tagWeights) {
          profile.tagWeights[name] = Math.max(profile.tagWeights[name], CONFIRMED_FLOOR);
        } else {
          profile.tagWeights[name] = CONFIRMED_FLOOR; // 确认一个还没数据的方向：直接立起来
        }
        profile.tagVerdicts = profile.tagVerdicts ?? {};
        profile.tagVerdicts[name] = 'confirmed';
      } else {
        delete profile.tagWeights[name];
        if (!profile.rejectedInterests.includes(name)) profile.rejectedInterests.push(name);
      }
    } else if (type === 'dislike') {
      if (verdict === 'confirmed') {
        if (!profile.confirmedDislikes.includes(name)) profile.confirmedDislikes.push(name);
      } else {
        profile.dislikedTags = profile.dislikedTags.filter((t) => t !== name);
      }
    } else if (type === 'author') {
      if (verdict === 'confirmed') {
        profile.authorAffinity[name] = Math.max(profile.authorAffinity[name] ?? 0, AUTHOR_FLOOR);
        profile.authorVerdicts = profile.authorVerdicts ?? {};
        profile.authorVerdicts[name] = 'confirmed';
      } else {
        delete profile.authorAffinity[name];
        if (!profile.rejectedAuthors.includes(name)) profile.rejectedAuthors.push(name);
      }
    }
  }
  return profile;
}

async function main() {
  const t0 = Date.now();
  await mkdir(STORAGE_DIR, { recursive: true });
  await rotateIfNeeded({ storageDir: STORAGE_DIR, eventsFile: EVENTS_FILE });

  const { events, duplicates, corrupted } = await readAllEvents({
    storageDir: STORAGE_DIR,
    eventsFile: EVENTS_FILE,
  });

  let prev = null;
  try {
    prev = JSON.parse(await readFile(PROFILE_FILE, 'utf8'));
  } catch {
    /* 首次运行 */
  }

  const profile = buildProfile(events, t0);
  // 先叠裁决再检测：confirmed 托底/反对清零都属于画像的"当前真值"，
  // 与上一轮（同样叠过裁决的）prev 比较才是同口径；裁决不改变 detect 的输入形状
  const verdicts = await loadVerdicts();
  applyVerdicts(profile, verdicts);
  const { significant, reasons } = detectSignificantChange(prev, profile);
  profile.portraitRebuildDue = significant; // P3：消费后由 soul 生成器清除

  const tmp = `${PROFILE_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  await rename(tmp, PROFILE_FILE);
  await chmod(PROFILE_FILE, 0o644); // NAS 权限保护层

  const tagCount = Object.keys(profile.tagWeights).length;
  console.log(
    `[profile] 事件 ${events.length} 条（去重 ${duplicates}，损坏跳过 ${corrupted}）→ ` +
      `tag 权重 ${tagCount} 个，避雷 ${profile.dislikedTags.length} 个，` +
      `来源亲和 ${Object.keys(profile.sourceAffinity).length} 个` +
      `（耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s）`,
  );
  if (significant) {
    console.log(`[profile] 检测到显著变化，P3 人格画像重建已标记待执行：${reasons.join('；')}`);
  }
}

main();
