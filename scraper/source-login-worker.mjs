import fs from 'node:fs';
import process from 'node:process';
import { LOGIN_REQUEST_FILE } from './source-login-store.mjs';
import { startLoginSession } from './source-login-session.mjs';

const parentPid = Number(process.env.SOURCE_LOGIN_PARENT_PID ?? 0);

async function checkOnce() {
  try {
    const request = JSON.parse(fs.readFileSync(LOGIN_REQUEST_FILE, 'utf8'));
    if (request?.status === 'requested') await startLoginSession(request.source);
  } catch {
    // 没有登录请求是常态；读取/解析失败留给下一次 API 重试。
  }
}

const timer = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    process.exit(0);
  }
  void checkOnce();
}, 2000);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}
