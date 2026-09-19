/**
 * zhipu.mjs — 智谱 GLM API 调用共用工具（tagger / github-summarizer 共用）。
 *
 * API key 解析优先级：
 *   1. 环境变量 ZHIPU_API_KEY
 *   2. ~/.config/opencode/opencode.jsonc 里的 provider.*.options.apiKey（带注释的 JSONC）
 * 找不到 key 直接 process.exit(1)（脚本场景，报错即退出最直观）。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const OPENCODE_CONFIG = path.join(homedir(), '.config', 'opencode', 'opencode.jsonc');

export const MODEL = process.env.ZHIPU_MODEL ?? 'glm-4-flash'; // 免费模型，成本为零
export const BASE_URL = (process.env.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');

/** 从 opencode.jsonc 里抠出智谱 apiKey（JSONC 带注释，需先剥离） */
function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
    } else {
      out += c;
    }
  }
  return out;
}

/** 解析 API key；找不到直接退出（沿用 tagger 的行为，报错信息也一致） */
export async function resolveApiKey() {
  if (process.env.ZHIPU_API_KEY) return process.env.ZHIPU_API_KEY;
  try {
    const cfg = JSON.parse(stripJsonComments(await readFile(OPENCODE_CONFIG, 'utf8')));
    const providers = cfg.provider ?? {};
    for (const p of Object.values(providers)) {
      const key = p?.options?.apiKey;
      if (typeof key === 'string' && key) return key;
    }
  } catch {
    /* 配置不存在或不合法，走下面的报错 */
  }
  console.error(`找不到 API key：请设置 ZHIPU_API_KEY，或确认 ${OPENCODE_CONFIG} 里有 provider.*.options.apiKey`);
  process.exit(1);
}

/**
 * 调 chat/completions，返回首个 choice 的文本。带超时与重试
 * （429/5xx/网络错误退避后重试，最多 3 次；其他状态码直接失败）。
 */
export async function chatComplete({ apiKey, model = MODEL, messages, temperature = 0.2, max_tokens = 200 }) {
  const body = JSON.stringify({ model, messages, temperature, max_tokens });

  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(60_000), // 长摘要比打标更耗时，超时放宽到 60s
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content.trim()) throw new Error('返回内容为空');
      return content;
    } catch (e) {
      lastErr = e.message;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(lastErr);
}
