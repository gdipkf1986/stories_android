// 探针2：未登录搜索页是否会请求 hotlist；响应结构长什么样
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN' });
const page = await ctx.newPage();

let hotlistBodies = [];
page.on('response', async (res) => {
  if (!res.url().includes('hotlist')) return;
  let body = '';
  try { body = (await res.text()).slice(0, 600); } catch {}
  hotlistBodies.push({ url: res.url(), status: res.status(), body });
});

try {
  await page.goto('https://www.xiaohongshu.com/search_result?keyword=', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForTimeout(6000);
  console.log(`[url] ${page.url()}`);
  console.log(`[hotlist calls] ${hotlistBodies.length}`);
  for (const b of hotlistBodies) console.log(JSON.stringify(b, null, 2));

  // 页面上有没有“热点”字样的板块
  const texts = await page.evaluate(() => {
    const hits = [];
    for (const el of document.querySelectorAll('div,section,span')) {
      const t = (el.textContent || '').trim();
      if (t.startsWith('热点') && t.length < 30) hits.push(t);
    }
    return [...new Set(hits)].slice(0, 10);
  });
  console.log('[hot sections]', JSON.stringify(texts));
} catch (e) {
  console.error('[FAIL]', e.message);
} finally {
  await browser.close();
}
