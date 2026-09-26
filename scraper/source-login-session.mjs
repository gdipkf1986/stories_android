import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  LOGIN_SESSION_FILE,
  LOGIN_REQUEST_FILE,
  writeLoginRequest,
  recordSourceLoginCheck,
  readLoginRequest,
} from './source-login-store.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QR_MAX_AGE_MS = 2 * 60_000;
const SESSION_MAX_AGE_MS = 10 * 60_000;

const SITES = {
  zhihu: {
    stateFile: path.resolve(import.meta.dirname, 'storage/zhihu-state.json'),
    loginUrl: 'https://www.zhihu.com/signin',
    homeUrl: 'https://www.zhihu.com/',
    origins: ['https://www.zhihu.com'],
    loginCookie: 'z_c0',
    qrSelectors: [
      'canvas.Qrcode-qrcode',
      'div.Qrcode-img img',
      'div.Qrcode-img',
      'div.Qrcode-container',
      'img[src*="qrcode"]',
    ],
  },
  bilibili: {
    stateFile: path.resolve(import.meta.dirname, 'storage/bilibili-state.json'),
    loginUrl: 'https://passport.bilibili.com/login',
    homeUrl: 'https://www.bilibili.com/',
    origins: ['https://www.bilibili.com', 'https://passport.bilibili.com'],
    loginCookie: 'SESSDATA',
    qrSelectors: [
      'img.qrcode-img',
      '.qrcode-box img',
      'canvas.qrcode-canvas',
      'img[src^="data:image"]',
      'img[src*="qrcode"]',
      '.login-qr img',
    ],
  },
};

let activeSession = null;

function writeSession(session) {
  fs.mkdirSync(path.dirname(LOGIN_SESSION_FILE), { recursive: true });
  const tempFile = `${LOGIN_SESSION_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(session, null, 2));
  fs.renameSync(tempFile, LOGIN_SESSION_FILE);
}

async function findQr(page, selectors) {
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const element = await frame.$(selector).catch(() => null);
      if (element && await element.isVisible().catch(() => false)) return element;
    }
  }
  return null;
}

async function captureQr(page, site, sessionId) {
  const qrFile = path.resolve(path.dirname(LOGIN_SESSION_FILE), `source-login-qr-${sessionId}.png`);
  const element = await findQr(page, site.qrSelectors);
  if (element) await element.screenshot({ path: qrFile });
  else await page.screenshot({ path: qrFile, fullPage: false });
  return qrFile;
}

async function saveState(context, site) {
  try {
    await context.storageState({ path: site.stateFile });
  } catch {
    const cookies = await context.cookies(...site.origins);
    fs.mkdirSync(path.dirname(site.stateFile), { recursive: true });
    fs.writeFileSync(site.stateFile, JSON.stringify({ cookies, origins: [] }, null, 2));
  }
}

async function runLoginSession(source, request) {
  const site = SITES[source];
  const sessionId = `${source}-${request.requestedAtMs}`;
  let session = {
    source,
    sessionId,
    status: 'pending',
    message: '正在生成登录二维码',
    qrPath: null,
    qrUpdatedAt: null,
    startedAt: request.requestedAt,
    startedAtMs: request.requestedAtMs,
  };
  writeSession(session);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: fs.existsSync(site.stateFile) ? site.stateFile : undefined,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      userAgent: UA,
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    for (let elapsed = 0; elapsed < SESSION_MAX_AGE_MS; elapsed += 2000) {
      const currentRequest = readLoginRequest(LOGIN_REQUEST_FILE);
      if (!currentRequest || currentRequest.sessionId !== sessionId) break;
      const cookies = await context.cookies(...site.origins);
      if (cookies.some((cookie) => cookie.name === site.loginCookie)) {
        await saveState(context, site);
        recordSourceLoginCheck(source, {
          required: false,
          reason: '',
          checkedAt: new Date().toISOString(),
        });
        session = { ...session, status: 'done', message: '登录成功', qrPath: null };
        writeSession(session);
        return;
      }

      const qrIsStale = !session.qrUpdatedAt || Date.now() - Date.parse(session.qrUpdatedAt) >= QR_MAX_AGE_MS;
      if (qrIsStale) {
        if (session.qrUpdatedAt) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
          await page.waitForTimeout(3000);
        }
        const qrPath = await captureQr(page, site, sessionId);
        session = {
          ...session,
          status: 'qr_ready',
          message: '请用客户端扫码登录',
          qrPath: path.basename(qrPath),
          qrUpdatedAt: new Date().toISOString(),
        };
        writeSession(session);
      }
      await page.waitForTimeout(2000);
      elapsed += 2000;
    }

    session = { ...session, status: 'expired', message: '二维码已过期，请刷新后重试' };
    writeSession(session);
  } catch (error) {
    session = {
      ...session,
      status: 'failed',
      message: '登录二维码生成失败',
      error: error.message.split('\n')[0],
    };
    writeSession(session);
  } finally {
    await browser?.close().catch(() => {});
    writeLoginRequest({
      ...request,
      status: session.status,
      completedAt: new Date().toISOString(),
    }, LOGIN_REQUEST_FILE);
  }
}

export async function startLoginSession(source, requestFile = LOGIN_REQUEST_FILE) {
  const request = readLoginRequest(requestFile);
  if (!request || request.source !== source) return null;
  const withSession = { ...request, sessionId: `${source}-${request.requestedAtMs}` };
  const requestTemp = `${requestFile}.tmp`;
  fs.writeFileSync(requestTemp, JSON.stringify(withSession, null, 2));
  fs.renameSync(requestTemp, requestFile);
  if (activeSession) return activeSession;

  activeSession = runLoginSession(source, withSession).finally(() => {
    activeSession = null;
  });
  return activeSession;
}

export function hasPendingLoginRequest(source) {
  const request = readLoginRequest(LOGIN_REQUEST_FILE);
  return request?.source === source && request.status === 'requested';
}
