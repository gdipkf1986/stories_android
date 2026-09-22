/**
 * article-text.mjs — 网页正文抓取/抽取与全文翻译（hn-summarizer / deploy/api.mjs 共用）。
 *
 * 抽取：纯字符串处理（零依赖），剥掉 script/style/nav 等非正文区块后
 *   article/main 优先、body 兜底，产出纯文本。
 * 翻译：智谱 GLM（zhipu.mjs），专有名词保留原文，输出纯段落文本；
 *   译文被 max_tokens 截断时回退到上一句句读，保证不以半句收尾。
 */
import { fetchText } from './github-http.mjs';
import { chatComplete } from './zhipu.mjs';

export const MAX_PAGE_CHARS = 6000; // 送进 LLM 的正文长度上限（摘要与全文翻译共用）
export const MIN_PAGE_CHARS = 200; // 低于此长度视为没抓到正文（反爬挡板页/cookie 墙）
const FETCH_TIMEOUT_MS = 15_000; // 单页抓取超时（外链站点质量参差，宁缺毋滥）

const TRANSLATE_PROMPT =
  '你是专业翻译。把用户给的英文文章翻译成简体中文：专有名词/项目名/公司名保留原文；' +
  '忠实原文，不增不减；不要 Markdown 格式、不要列表符号、不要小标题；段落之间用换行分隔。' +
  '只输出译文正文，不要任何解释。';

// ---------- 正文抓取与文本抽取 ----------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const num = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(num) && num > 0 && num < 0x110000 ? String.fromCodePoint(num) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

const tagsToText = (fragment) =>
  decodeEntities(String(fragment).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** HTML → 正文纯文本：剔除脚本/样式/导航等非正文区块后，article/main 优先，兜底全 body */
export function extractArticleText(html) {
  const cleaned = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const main = cleaned.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main?.[2]) {
    const inner = tagsToText(main[2]);
    if (inner.length >= MIN_PAGE_CHARS) return inner;
  }
  const body = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return tagsToText(body ? body[1] : cleaned);
}

/** 抓外链原文并剥出正文；任何失败（付费墙/403/超时/PDF）都返回空串 */
export async function fetchArticleText(url) {
  try {
    const page = await fetchText(url, { Accept: 'text/html,application/xhtml+xml' }, FETCH_TIMEOUT_MS);
    if (!page || page.slice(0, 5) === '%PDF-') return '';
    const text = extractArticleText(page);
    return text.length >= MIN_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : '';
  } catch {
    return '';
  }
}

// ---------- 全文翻译（按需：前端点「翻译全文」时由 API 调用） ----------

/**
 * 正文全文翻译。超时/重试由调用方按场景收紧（API 在线请求等不起 3 轮重试）。
 * 输出被 token 截断时回退到上一句句读，保证不以半句收尾。
 */
export async function translateArticleText(content, apiKey, { timeoutMs = 60_000, retries = 2 } = {}) {
  const res = await chatComplete({
    apiKey,
    messages: [
      { role: 'system', content: TRANSLATE_PROMPT },
      { role: 'user', content },
    ],
    temperature: 0.1,
    max_tokens: 4000,
    timeoutMs,
    retries,
  });
  let zh = res.trim();
  if (!/[。！？…”"']$/.test(zh)) {
    const last = Math.max(zh.lastIndexOf('。'), zh.lastIndexOf('！'), zh.lastIndexOf('？'));
    if (last > 100) zh = zh.slice(0, last + 1); // 截断的半句丢掉
  }
  if (zh.length < 50) throw new Error(`译文异常 (${zh.length} 字)`);
  return zh;
}
