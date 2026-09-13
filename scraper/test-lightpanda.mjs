/**
 * lightpanda 连通性测试：
 *  1. CDP 连接 → 打开知乎登录页 → 找二维码并截图
 *  2. 导入 zhihu-state.json 的 cookie → 访问知乎首页验证登录态
 * 用法: node scraper/test-lightpanda.mjs [cdp-url]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.argv[2] ?? 'http://127.0.0.1:9222';
const STATE = path.join(import.meta.dirname, 'storage/zhihu-state.json');

const browser = await chromium.connectOverCDP(CDP);
console.log('[OK] CDP 连接成功');
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();

// ---- 测试 1：登录页 + 二维码 ----
await page.goto('https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);
console.log('[INFO] 登录页标题:', await page.title());
const SELECTORS = [
  'canvas.Qrcode-qrcode',
  'div.Qrcode-img img',
  'div.Qrcode-img',
  'div.Qrcode-container',
  "img[src*='qrcode']",
];
let qr = null;
for (const sel of SELECTORS) {
  const el = await page.$(sel);
  if (el && (await el.isVisible().catch(() => false))) { qr = el; console.log('[OK] 找到二维码:', sel); break; }
}
if (qr) {
  await qr.screenshot({ path: path.join(import.meta.dirname, 'storage/lightpanda-login-qr.png') });
  console.log('[OK] 二维码截图已保存');
} else {
  await page.screenshot({ path: path.join(import.meta.dirname, 'storage/lightpanda-login-qr.png') });
  console.log('[WARN] 未找到二维码元素，已保存整页截图');
}

// ---- 测试 2：导入 cookie 验证登录态 ----
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
await context.addCookies(state.cookies ?? []);
console.log(`[INFO] 导入 ${state.cookies?.length ?? 0} 条 cookie`);
await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);
const back = await context.cookies('https://www.zhihu.com');
console.log('[INFO] 首页标题:', await page.title(), '| 当前 cookie 数:', back.length);
console.log(back.some((c) => c.name === 'z_c0') ? '[OK] z_c0 登录态在 context 中有效' : '[WARN] z_c0 未见（addCookies 或 cookie 域处理可能有出入）');

await browser.close();
