/**
 * 用户裁决存储：scraper/storage/profile-verdicts.json
 *
 * 借鉴 OpenBiliClaw 的两层设计：AI 画像（profile.json，引擎可反复重算）与
 * 用户裁决（本文件）**分开持久化**——用户对某条分析结果的"确认/反对"
 * 是确定性修正，画像重建永不覆盖；读取时由 profile-engine 作为覆盖层叠加。
 *
 * key 规则：`<type>:<名称>`，type ∈ tag（兴趣分析）| dislike（避雷分析）| author（作者亲和）
 * verdict：confirmed（确认说得对）| rejected（反对， suppression）| none（撤销裁决）
 * 反对语义（按类型不同）：
 *   tag:X     → 权重清零，从兴趣画像移除（事件继续记，但排序不再当兴趣用）
 *   dislike:X → 移出避雷（不是雷点；后续同类显式 dislike 事件仍会重新进避雷）
 *   author:X  → 清零作者亲和，且其内容不再进入推荐流
 */
import { readFile, writeFile, rename, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * 存储路径可用环境变量覆盖：宿主机上默认 scraper/storage/ 下；
 * API 容器里由 start-api.sh 指到 rw 挂载的 /app/storage（同一份宿主文件）。
 */
export const VERDICTS_FILE =
  process.env.VERDICTS_FILE ?? path.resolve(import.meta.dirname, 'storage', 'profile-verdicts.json');

export const VERDICT_VALUES = /** @type {const} */ (['confirmed', 'rejected', 'none']);
export const KEY_TYPES = /** @type {const} */ (['tag', 'dislike', 'author']);
const KEY_RE = /^(tag|dislike|author):(.{1,60})$/;

/** 读取裁决表：Map<key, {verdict, at}>；文件缺失/损坏视为空 */
export async function loadVerdicts(file = VERDICTS_FILE) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const map = new Map();
    for (const [key, v] of Object.entries(raw.verdicts ?? {})) {
      if (!KEY_RE.test(key)) continue;
      if (!VERDICT_VALUES.includes(v?.verdict)) continue;
      map.set(key, { verdict: v.verdict, at: v.at ?? '' });
    }
    return map;
  } catch {
    return new Map();
  }
}

/** 原子写入裁决表；verdict=none 的条目直接删除（不留垃圾） */
export async function saveVerdicts(map, file = VERDICTS_FILE) {
  const verdicts = {};
  for (const [key, v] of map) {
    if (v.verdict === 'none') continue;
    verdicts[key] = v;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const data = { version: 1, updated_at: new Date().toISOString(), verdicts };
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  await chmod(file, 0o644); // NAS 权限保护层
}

/** 校验单次裁决请求；返回 { key, verdict } 或 null */
export function normalizeVerdictInput(input) {
  if (input === null || typeof input !== 'object') return null;
  const key = String(input.key ?? '');
  const verdict = String(input.verdict ?? '');
  if (!KEY_RE.test(key)) return null;
  if (!VERDICT_VALUES.includes(verdict)) return null;
  return { key, verdict };
}

/** 裁决某个 key（upsert；none = 撤销） */
export function applyVerdict(map, key, verdict) {
  if (verdict === 'none') map.delete(key);
  else map.set(key, { verdict, at: new Date().toISOString() });
}
