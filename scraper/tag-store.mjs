/**
 * 条目 AI 标签的持久化存储与合并工具（按源命名空间隔离）。
 *
 * 为什么标签要独立存储（scraper/storage/<source>-tags.json，已 gitignore）：
 * 抓取产物每次都是整份覆盖，把标签直接写进 feed JSON 会被下一次
 * 同步冲掉。独立标签库按条目原始 id 索引，sync / 打标时合并注入，
 * 重新抓取、换机器同步都不会丢标签。
 *
 * 为什么按源分文件：不同源的原始 id 都是裸数字（知乎问题 id、B站 aid），
 * 混在一个库里会互相撞 id 打错标签，所以 zhihu / bilibili 各一个文件。
 */
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';

const STORAGE_DIR = path.resolve(import.meta.dirname, 'storage');

/** 某个源的标签库文件路径（zhihu 沿用旧文件名 zhihu-tags.json，历史数据不迁移） */
export function tagsFileFor(source = 'zhihu') {
  return path.join(STORAGE_DIR, `${source === 'zhihu' ? 'zhihu' : source}-tags.json`);
}

/** 读取标签库，返回 Map<条目原始id, tags[]>；文件不存在或损坏视为空库 */
export async function loadTagStore(source = 'zhihu') {
  const TAGS_FILE = tagsFileFor(source);
  try {
    const raw = JSON.parse(await readFile(TAGS_FILE, 'utf8'));
    const map = new Map();
    for (const [id, tags] of Object.entries(raw.tags ?? {})) {
      if (Array.isArray(tags)) {
        const clean = tags.filter((t) => typeof t === 'string' && t.trim() !== '');
        if (clean.length > 0) map.set(id, clean);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** 原子写入标签库（先写 tmp 再 rename，中途崩溃不会留下半截 JSON） */
export async function saveTagStore(store, { model = null, source = 'zhihu' } = {}) {
  const TAGS_FILE = tagsFileFor(source);
  await mkdir(path.dirname(TAGS_FILE), { recursive: true });
  const data = {
    version: 1,
    source,
    updated_at: new Date().toISOString(),
    model,
    tags: Object.fromEntries(store),
  };
  const tmp = `${TAGS_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, TAGS_FILE);
  await chmod(TAGS_FILE, 0o644); // NAS 权限保护层：确保其他用户可读
}

/**
 * 把标签库合并进 feed 数据：给每条匹配的 item 注入 tags 字段。
 * 返回注入的条数（同一 id 出现在多个流里会分别注入）。
 */
export function applyTags(feedData, store) {
  let n = 0;
  for (const feed of feedData.feeds ?? []) {
    for (const item of feed.items ?? []) {
      const tags = store.get(String(item.id));
      if (tags && tags.length > 0) {
        item.tags = tags;
        n++;
      }
    }
  }
  return n;
}
