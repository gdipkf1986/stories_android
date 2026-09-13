/**
 * 探测 lightpanda 能否支撑 zhihu-feed.mjs 的两种抓取方式：
 *  1. API 拦截（page.on('response') + res.json()）—— recommend/follow 流依赖
 *  2. DOM 提取（page.evaluate + querySelectorAll）—— 热榜依赖
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const state = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'storage/zhihu-state.json'), 'utf8'));

const page = await context.newPage();
await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await context.addCookies(state.cookies); // 需在 context 有活动文档后导入
await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

let apiHits = 0;
let bodyOk = 0;
let items = 0;
page.on('response', async (res) => {
  const u = res.url();
  if (!u.includes('feed/topstory/recommend') && !u.includes('/api/v3/moments')) return;
  apiHits++;
  try {
    const body = await res.json();
    if (body) {
      bodyOk++;
      const arr = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
      items += arr.length;
    }
  } catch { /* 响应体不可读 */ }
});

console.log('--- 测试 1: 推荐流 API 拦截 ---');
await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
for (let i = 0; i < 3; i++) {
  await page.mouse.wheel(0, 2600);
  await page.waitForTimeout(1500);
}
console.log(`API 响应事件: ${apiHits} | 响应体可读: ${bodyOk} | 累计条目: ${items}`);

console.log('--- 测试 2: 热榜 DOM 提取 ---');
await page.goto('https://www.zhihu.com/hot', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);
const hotCount = await page.evaluate(() => document.querySelectorAll('.HotItem').length);
console.log(`热榜 .HotItem 条目: ${hotCount}`);

await browser.close();
