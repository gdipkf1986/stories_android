#!/usr/bin/env node
/**
 * 排序器：全部数据源的条目 × 偏好层 → public/data/recommendations.json
 *
 * 打分公式（权重起步值移植自 OpenBiliClaw curator 的实测校准，后续按点击日志调）：
 *   score = 相关性×0.30 + 时效×0.10 − 话题疲劳×0.25 − 来源单调×0.15
 *         + 探索×0.20 + 作者加成
 * 惊喜/探索权重(0.20)刻意仅次于相关性——让没点过的领域也能浮上来。
 *
 * 多样化（纯代码零成本）：
 *   - Jaccard-MMR：α×分数 − β×与已选的最大 tag 相似度，打散同题换皮
 *   - 硬上限：单 tag、单来源各设全局配额
 *
 * 数据源无关：候选来自 sources.node.mjs 注册的全部源，新源接入即生效。
 * 输出是"id + 分数 + 理由"的轻量文件，前端自己映射到已加载的 TimelineItem，
 * 不复制条目内容（单一事实源，不会出现两份数据打架）。
 *
 * 用法: npm run rank   （幂等；profile.json 不存在时自动退化为冷启动排序）
 */
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { loadAllSources, STRUCTURAL_TAGS } from './sources.node.mjs';

const STORAGE_DIR = path.resolve(import.meta.dirname, 'storage');
const PROFILE_FILE = path.join(STORAGE_DIR, 'profile.json');
const RANK_STATE_FILE = path.join(STORAGE_DIR, 'rank-state.json');
const OUT_FILE = path.resolve(import.meta.dirname, '..', 'public', 'data', 'recommendations.json');

const W = { relevance: 0.3, freshness: 0.1, fatigue: 0.25, monotony: 0.15, serendipity: 0.2 };
const LIMIT = Number(process.env.RANK_LIMIT ?? 120) || 120;
const MAX_AGE_DAYS = Number(process.env.RANK_MAX_AGE_DAYS ?? 30) || 30;
// 最近展示记录（疲劳计算窗口）。去重窗口的数学约束：每轮候选数 = 池 - 窗口内已推数，
// 要恒有 LIMIT 条可选，需要 窗口轮数 × LIMIT ≤ 池规模。调度 15 分钟/轮、池 ~300、
// LIMIT 120 → 窗口最多 1 轮：16 分钟（>调度间隔，保证上一轮必被排除），每轮候选
// 恒 ≈ 池 - 120 ≈ 164，满额输出。窗口再长必饿死（实测 30 分钟窗口轮出 44 条、1 天
// 窗口直接 0 条）。推荐流是快照式输出（每轮整体重建），跨轮重复感知很低。
const SHOWN_CAP = 1200;
const SHOWN_SKIP_MS = 16 * 60 * 1000; // 上一轮推过的本轮不再推（隔轮去重）
const TAG_CAP = Math.max(2, Math.round(LIMIT * 0.1)); // 单 tag 全局配额
// 单来源配额：按源数量摊分并放宽 1.5 倍——既要防单源霸屏，也要保证凑得满 LIMIT
// （写死 LIMIT×0.3 时两源合计上限只有 0.6×LIMIT，推荐流会莫名叫不满）
const SOURCE_CAP = (n) => Math.max(3, Math.ceil((LIMIT / Math.max(1, n)) * 1.5));

const DAY = 24 * 3600 * 1000;
const jaccard = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const t0 = Date.now();
  const now = Date.now();
  const profile = await readJson(PROFILE_FILE, null);
  const state = await readJson(RANK_STATE_FILE, { shown: [] });
  const tagWeights = profile?.tagWeights ?? {};
  const disliked = new Set(profile?.dislikedTags ?? []);
  const authorAffinity = profile?.authorAffinity ?? {};
  const rejectedAuthors = new Set(profile?.rejectedAuthors ?? []); // 用户反对的作者：内容整条排除

  // ── 候选：全部数据源 ──────────────────────────────────────────
  const { items: allItems, failures } = await loadAllSources();
  if (allItems.length === 0) {
    console.error('[rank] 没有任何候选条目（public/data 为空？）先跑 npm run scrape / sync');
    process.exit(1);
  }
  const shownRecent = new Set(
    (state.shown ?? []).filter((s) => now - (s.at ?? 0) < SHOWN_SKIP_MS).map((s) => s.id),
  );
  const shownTagCount = {};
  for (const s of state.shown ?? []) {
    // 结构标签不参与疲劳统计：B站条目全带「视频」，一起计入会把全源统一打进
    // 疲劳惩罚（-0.25），知乎的分散 AI 标签却毫发无伤 → 为你推荐被知乎刷屏
    for (const tag of s.tags ?? []) {
      if (STRUCTURAL_TAGS.has(tag)) continue;
      shownTagCount[tag] = (shownTagCount[tag] ?? 0) + 1;
    }
  }

  const candidates = [];
  let excludedDislike = 0;
  let excludedAuthor = 0;
  for (const item of allItems) {
    if (item.createdAt <= 0 && item.tags.length === 0) continue;
    if (shownRecent.has(item.id)) continue;
    if (item.author && rejectedAuthors.has(item.author)) {
      excludedAuthor++;
      continue;
    }
    const itemTags = new Set(item.tags);
    // 结构标签不参与避雷判定（画像引擎已不再记，但历史 profile.json 里的
    // 「视频」「热榜」等脏数据仍可能存在，这里兜底）
    const hitDislike = [...itemTags].some((t) => disliked.has(t) && !STRUCTURAL_TAGS.has(t));
    if (hitDislike) {
      excludedDislike++;
      continue;
    }
    const ageDays = item.createdAt > 0 ? (now - item.createdAt) / DAY : MAX_AGE_DAYS;
    if (ageDays > MAX_AGE_DAYS) continue;

    // 相关性：命中画像 tag 的 max 与 avg 各占一半
    const weights = item.tags.map((t) => tagWeights[t] ?? 0);
    const maxW = weights.length > 0 ? Math.max(...weights) : 0;
    const avgW = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
    const relevance = Math.max(0, maxW * 0.5 + avgW * 0.5);

    const freshness = Math.max(0, 1 - ageDays / MAX_AGE_DAYS);
    // 话题疲劳：近窗口里同 tag 已展示次数，count^1.5 陡曲线（2 次→0.35，4 次→1）
    const fatigueCount = Math.max(0, ...item.tags.map((t) => shownTagCount[t] ?? 0));
    const fatigue = Math.min(1, (fatigueCount ** 1.5) / 8);
    // 来源单调：最近展示里同来源占比
    const recentWindow = (state.shown ?? []).slice(0, 10);
    const sameSource = recentWindow.filter((s) => s.source === item.source).length;
    const monotony = recentWindow.length > 0 ? sameSource / recentWindow.length : 0;
    // 探索：tags 全部或大半是画像里没见过的（且不是避雷）→ 破茧加权
    const unseen = item.tags.filter((t) => !(t in tagWeights)).length;
    const exploreRatio = item.tags.length > 0 ? unseen / item.tags.length : 0;
    const serendipity = exploreRatio >= 0.99 ? 1 : exploreRatio >= 0.5 ? 0.4 : 0;
    const authorBoost = (authorAffinity[item.author] ?? 0) * 0.15;

    const score =
      relevance * W.relevance +
      freshness * W.freshness -
      fatigue * W.fatigue -
      monotony * W.monotony +
      serendipity * W.serendipity +
      authorBoost;

    candidates.push({ item, score, relevance, fatigue, serendipity, matched: item.tags.filter((t) => t in tagWeights) });
  }

  candidates.sort((a, b) => b.score - a.score);

  // ── Jaccard-MMR 多样化选择 ───────────────────────────────────
  const tagCountSel = {};
  const sourceCountSel = {};
  const sourceCap = SOURCE_CAP(new Set(allItems.map((it) => it.source)).size);
  // tag 配额只数内容标签：结构标签（视频/热榜…）全源同质，参与计数会把
  // 整个来源卡死在 TAG_CAP 上（B站 111 条全带「视频」，12 条后全被丢弃）
  const contentTagsOf = (item) => item.tags.filter((t) => !STRUCTURAL_TAGS.has(t));
  const selected = [];
  const tagSets = new Map(candidates.map((c) => [c.item.id, new Set(c.item.tags)]));
  const pool = [...candidates];
  while (selected.length < LIMIT && pool.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(tagSets.get(c.item.id), tagSets.get(s.item.id));
        if (sim > maxSim) maxSim = sim;
      }
      // 候选多时用采样近似，避免 140×60 的全量两两比较也无所谓——量小直接算
      const val = 0.7 * c.score - 0.3 * maxSim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const picked = pool.splice(bestIdx, 1)[0];
    const pickedContentTags = contentTagsOf(picked.item);
    const overTag = pickedContentTags.some((t) => (tagCountSel[t] ?? 0) >= TAG_CAP);
    const overSource = (sourceCountSel[picked.item.source] ?? 0) >= sourceCap;
    if (overTag || overSource) continue; // 超配额：丢弃并继续找下一个
    selected.push(picked);
    for (const t of pickedContentTags) tagCountSel[t] = (tagCountSel[t] ?? 0) + 1;
    sourceCountSel[picked.item.source] = (sourceCountSel[picked.item.source] ?? 0) + 1;
  }

  // ── 源交错输出 ──────────────────────────────────────────────
  // MMR 按分数挑人，选中集的跨源比例会随候选池状态波动，直接按分数输出
  // 会排成长段单源（体感：刷很久见不到 B站）。按「源内分数序 + 等权轮转」
  // 重排：相邻条目尽量不同源，各源内部仍保持分数从高到低。
  {
    const bySource = new Map();
    for (const c of selected) {
      const list = bySource.get(c.item.source);
      if (list) list.push(c);
      else bySource.set(c.item.source, [c]);
    }
    const keyed = [];
    for (const list of bySource.values()) {
      list.forEach((c, j) => keyed.push({ c, key: j + 0.5 }));
    }
    keyed.sort((a, b) => a.key - b.key);
    selected.length = 0;
    selected.push(...keyed.map((k) => k.c));
  }

  // ── 理由（模板版；P3 可换 LLM 批量润色）──────────────────────
  const cold = profile === null || Object.keys(tagWeights).length === 0;
  const reasonFor = (c) => {
    if (cold) return '冷启动：按新鲜度挑选，点「喜欢/不感兴趣」后会越来越懂你';
    const parts = [];
    if (c.serendipity >= 1) return `探索新方向：${c.item.tags[0] ?? '陌生领域'}，猜你可能感兴趣`;
    const likedAuthor = authorAffinity[c.item.author] ?? 0;
    if (likedAuthor >= 0.3) parts.push(`「${c.item.author}」你之前喜欢过`);
    if (c.matched.length > 0) {
      const top = [...c.matched].sort((a, b) => (tagWeights[b] ?? 0) - (tagWeights[a] ?? 0)).slice(0, 2);
      parts.push(`和你常看的「${top.join('」「')}」是一路的`);
    }
    if (parts.length === 0) parts.push('近期较新的内容');
    return parts.join('，');
  };

  // ── 输出：轻量推荐流（id+分数+理由，前端映射到 TimelineItem）──
  const out = {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    coldStart: cold,
    windowDays: MAX_AGE_DAYS,
    items: selected.map((c) => ({
      id: c.item.id,
      source: c.item.source,
      score: Number(c.score.toFixed(4)),
      explore: c.serendipity >= 1,
      matchedTags: c.matched.slice(0, 3),
      reason: reasonFor(c),
    })),
  };

  const tmp = `${OUT_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  await rename(tmp, OUT_FILE);
  await chmod(OUT_FILE, 0o644); // NAS 权限保护层：nginx 容器可读

  // 记录展示（下轮疲劳/去重的依据）
  const nextShown = [
    ...selected.map((c) => ({ id: c.item.id, source: c.item.source, tags: c.item.tags, at: now })),
    ...(state.shown ?? []),
  ].slice(0, SHOWN_CAP);
  const stateTmp = `${RANK_STATE_FILE}.tmp`;
  await writeFile(stateTmp, `${JSON.stringify({ version: 1, shown: nextShown }, null, 2)}\n`, 'utf8');
  await rename(stateTmp, RANK_STATE_FILE);

  console.log(
    `[rank] 候选 ${candidates.length} 条（避雷排除 ${excludedDislike}，反对作者排除 ${excludedAuthor}，近期已推跳过）` +
      `${failures.length > 0 ? `，加载失败源: ${failures.map((f) => f.source).join(',')}` : ''}` +
      ` → 推荐 ${out.items.length} 条${cold ? '（冷启动）' : ''}` +
      `，探索位 ${out.items.filter((i) => i.explore).length} 条` +
      `（耗时 ${((Date.now() - t0) / 1000).toFixed(2)}s）`,
  );
}

main();
