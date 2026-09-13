// login-qr-png.mjs — 知乎扫码登录辅助：保存二维码截图、等待登录完成、落盘登录态
//
// 用法:
//   npm run scrape:login                    # 默认 chromium（Playwright 自带内核）
//   npm run scrape:login -- --browser lightpanda   # 用 Lightpanda 浏览器（docker，需本机有 docker）
//   ZHIHU_LOGIN_BROWSER=lightpanda npm run scrape:login
//   ZHIHU_CDP_URL=http://127.0.0.1:9222 ...        # 连接已运行的 Lightpanda CDP 服务
//
// Lightpanda 模式说明:
//   - 若 ZHIHU_CDP_URL 不可达，会自动 docker run 一个 lightpanda/browser 容器
//   - 登录态通过 addCookies 导入、storageState 落盘（与 chromium 模式通用）
import { chromium } from "playwright";
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";

const STATE = path.join(import.meta.dirname, "storage/zhihu-state.json");
const SHOT = path.join(import.meta.dirname, "storage/login-qr.png");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const BROWSER = argOf("--browser") ?? process.env.ZHIHU_LOGIN_BROWSER ?? "chromium";
const USE_LIGHTPANDA = BROWSER.toLowerCase() === "lightpanda";
const CDP_URL = process.env.ZHIHU_CDP_URL ?? "http://127.0.0.1:9222";
const CDP_HOST = new URL(CDP_URL).host;
const LP_CONTAINER = "lightpanda";

const QR_SELECTORS = [
  "canvas.Qrcode-qrcode",
  "div.Qrcode-img img",
  "div.Qrcode-img",
  "div.Qrcode-container",
  "img[src*='qrcode']",
];

function cdpAlive() {
  return new Promise((resolve) => {
    const req = http.get(`${CDP_URL}/json/version`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/** 若 CDP 服务不可达，用 docker 拉起一个 lightpanda 容器（常驻 + 随 docker 自启） */
async function ensureLightpanda() {
  if (await cdpAlive()) {
    console.log(`[INFO] Lightpanda CDP 已在运行: ${CDP_URL}`);
    return;
  }
  console.log("[INFO] Lightpanda CDP 未运行，正在用 docker 启动…");
  try { execSync(`docker rm -f ${LP_CONTAINER}`, { stdio: "ignore" }); } catch {}
  execSync(
    `docker run -d --name ${LP_CONTAINER} --restart unless-stopped ` +
      `-p 127.0.0.1:9222:9222 ` +
      `lightpanda/browser:latest lightpanda serve --host 0.0.0.0 --port 9222`,
    { stdio: "inherit" },
  );
  for (let i = 0; i < 30; i++) {
    if (await cdpAlive()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Lightpanda CDP 服务启动超时（检查 docker 与端口 9222）");
}

async function findQr(page) {
  for (const sel of QR_SELECTORS) {
    const el = await page.$(sel);
    if (el && (await el.isVisible().catch(() => false))) return el;
  }
  return null;
}

async function snapQr(page, tag) {
  const qr = await findQr(page);
  if (qr) {
    await qr.screenshot({ path: SHOT });
    console.log(`${tag}:${SHOT}`);
  } else {
    await page.screenshot({ path: SHOT, fullPage: false });
    console.log(`${tag}_FULLPAGE:${SHOT}`);
  }
}

/** CDP 连接的 context 不一定支持 storageState，失败时退化为手工导出 cookie */
async function saveState(context) {
  try {
    await context.storageState({ path: STATE });
  } catch (e) {
    console.log(`[WARN] storageState 不可用（${e.message.split("\n")[0]}），改为仅导出 cookies`);
    const cookies = await context.cookies("https://www.zhihu.com");
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ cookies, origins: [] }, null, 2));
  }
}

(async () => {
  let browser;
  let context;
  if (USE_LIGHTPANDA) {
    await ensureLightpanda();
    browser = await chromium.connectOverCDP(CDP_URL);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      storageState: fs.existsSync(STATE) ? STATE : undefined,
      viewport: { width: 1920, height: 1080 },
      userAgent: UA,
    });
  }

  const page = await context.newPage();
  await page.goto("https://www.zhihu.com/signin", { waitUntil: "domcontentloaded", timeout: 30000 });

  // Lightpanda 的 Storage.setCookies 要求 context 已有活动文档，故在建页之后再导入
  if (USE_LIGHTPANDA && fs.existsSync(STATE)) {
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (state.cookies?.length) {
      try {
        await context.addCookies(state.cookies);
        console.log(`[INFO] 已导入 ${state.cookies.length} 条 cookie`);
        await page.goto("https://www.zhihu.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        console.log(`[WARN] cookie 导入失败: ${e.message.split("\n")[0]}`);
      }
    }
  }

  await page.waitForTimeout(3000);
  await snapQr(page, "QR_SAVED");

  for (let i = 0; i < 72; i++) {
    await page.waitForTimeout(5000);
    const cookies = await context.cookies("https://www.zhihu.com");
    if (cookies.some((c) => c.name === "z_c0")) {
      await saveState(context);
      console.log("LOGIN_OK");
      break;
    }
    if (!page.url().includes("signin")) {
      await page.goto("https://www.zhihu.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    if (i > 0 && i % 16 === 0) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3000);
      await snapQr(page, "QR_REFRESHED");
    }
  }
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("FATAL", e.message);
  process.exit(1);
});
