// login-qr-png.mjs — 知乎/B站 扫码登录辅助：保存二维码截图、等待登录完成、落盘登录态
//
// 用法:
//   npm run scrape:login                     # 知乎（默认站点）
//   npm run scrape:login:bilibili            # B站（生成 storage/bilibili-state.json）
//   node scraper/login-qr-png.mjs --site bilibili
//   npm run scrape:login -- --browser lightpanda    # 用 Lightpanda 浏览器（docker）
//   ZHIHU_LOGIN_BROWSER=lightpanda npm run scrape:login
//   ZHIHU_CDP_URL=http://127.0.0.1:9222 ...         # 连接已运行的 Lightpanda CDP 服务
//
// Lightpanda 模式说明:
//   - 若 ZHIHU_CDP_URL 不可达，会自动 docker run 一个 lightpanda/browser 容器
//   - 登录态通过 addCookies 导入、storageState 落盘（与 chromium 模式通用）
import { chromium } from "playwright";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import http from "http";

const ROOT = import.meta.dirname;

// 各站点的登录差异收敛在这里；抓取脚本（zhihu-feed.mjs / bilibili-feed.mjs）
// 分别按 storage/<site>-state.json 读取登录态
const SITES = {
  zhihu: {
    state: path.join(ROOT, "storage/zhihu-state.json"),
    shot: path.join(ROOT, "storage/login-qr.png"),
    loginUrl: "https://www.zhihu.com/signin",
    origins: ["https://www.zhihu.com"],
    loginCookie: "z_c0",
    onLoginPage: (u) => u.includes("signin"),
    qrSelectors: [
      "canvas.Qrcode-qrcode",
      "div.Qrcode-img img",
      "div.Qrcode-img",
      "div.Qrcode-container",
      "img[src*='qrcode']",
    ],
  },
  bilibili: {
    state: path.join(ROOT, "storage/bilibili-state.json"),
    shot: path.join(ROOT, "storage/bilibili-login-qr.png"),
    loginUrl: "https://passport.bilibili.com/login",
    origins: ["https://www.bilibili.com", "https://passport.bilibili.com"],
    loginCookie: "SESSDATA",
    onLoginPage: (u) => u.includes("passport.bilibili.com"),
    qrSelectors: [
      "img.qrcode-img",
      ".qrcode-box img",
      "canvas.qrcode-canvas",
      // passport 页二维码由接口返回 base64 data URI 直接塞进 <img src>
      "img[src^='data:image']",
      "img[src*='qrcode']",
      ".login-qr img",
    ],
  },
};

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const SITE_NAME = argOf("--site") ?? "zhihu";
const SITE = SITES[SITE_NAME];
if (!SITE) {
  console.error(`未知站点: ${SITE_NAME}（可选: ${Object.keys(SITES).join(" / ")}）`);
  process.exit(1);
}
const { state: STATE, shot: SHOT } = SITE;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BROWSER = argOf("--browser") ?? process.env.ZHIHU_LOGIN_BROWSER ?? "chromium";
const USE_LIGHTPANDA = BROWSER.toLowerCase() === "lightpanda";
const CDP_URL = process.env.ZHIHU_CDP_URL ?? "http://127.0.0.1:9222";
const LP_CONTAINER = "lightpanda";

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
  // 遍历所有 frame（主文档 + iframe），防止二维码嵌在 iframe 里找不到
  for (const frame of page.frames()) {
    for (const sel of SITE.qrSelectors) {
      const el = await frame.$(sel).catch(() => null);
      if (el && (await el.isVisible().catch(() => false))) return el;
    }
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
    const cookies = await context.cookies(...SITE.origins);
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
      deviceScaleFactor: 2,
      userAgent: UA,
      locale: "zh-CN",
    });
  }

  const page = await context.newPage();
  // B站二维码由 /qrcode/generate 接口下发，拦截响应可拿到确认页 URL（扫码失败时可改为直接在手机上打开该链接确认）
  if (SITE_NAME === "bilibili") {
    page.on("response", async (res) => {
      if (/qrcode\/generate/.test(res.url())) {
        try {
          const j = await res.json();
          if (j?.data?.url) console.log(`LOGIN_URL:${j.data.url}`);
        } catch {}
      }
      if (/qrcode\/query/.test(res.url())) {
        try {
          const j = await res.json();
          const code = j?.data?.code;
          // 86101=未扫 86090=已扫未确认 86038=已过期 0=成功
          console.log(`QR_POLL:${code} ${j?.data?.message ?? ""}`);
        } catch {}
      }
    });
  }
  await page.goto(SITE.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Lightpanda 的 Storage.setCookies 要求 context 已有活动文档，故在建页之后再导入
  if (USE_LIGHTPANDA && fs.existsSync(STATE)) {
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (state.cookies?.length) {
      try {
        await context.addCookies(state.cookies);
        console.log(`[INFO] 已导入 ${state.cookies.length} 条 cookie`);
        await page.goto(SITE.origins[0], { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch (e) {
        console.log(`[WARN] cookie 导入失败: ${e.message.split("\n")[0]}`);
      }
    }
  }

  await page.waitForTimeout(3000);
  await snapQr(page, "QR_SAVED");

  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(5000);
    const cookies = await context.cookies(...SITE.origins);
    if (cookies.some((c) => c.name === SITE.loginCookie)) {
      await saveState(context);
      console.log("LOGIN_OK");
      break;
    }
    if (!SITE.onLoginPage(page.url())) {
      await page.goto(SITE.origins[0], { waitUntil: "domcontentloaded" }).catch(() => {});
    }
    if (i > 0 && i % 24 === 0) {
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
