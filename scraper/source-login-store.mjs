import fs from 'node:fs';
import path from 'node:path';

export const LOGIN_SOURCES = ['zhihu', 'bilibili'];
export const SOURCE_STATUS_FILE = path.join(defaultStorageDir(), 'source-status.json');
export const LOGIN_REQUEST_FILE = path.join(defaultStorageDir(), 'source-login-request.json');
export const LOGIN_SESSION_FILE = path.join(defaultStorageDir(), 'source-login-session.json');

function defaultStorageDir() {
  return process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : path.resolve(import.meta.dirname, 'storage');
}

function emptyStatus() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sources: Object.fromEntries(LOGIN_SOURCES.map((source) => [source, {
      loginRequired: false,
      reason: '',
      checkedAt: null,
    }])),
  };
}

export function readSourceLoginStatus(statusFile = SOURCE_STATUS_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    const empty = emptyStatus();
    return {
      ...empty,
      ...parsed,
      sources: { ...empty.sources, ...(parsed.sources ?? {}) },
    };
  } catch {
    return emptyStatus();
  }
}

export function writeSourceLoginStatus(status, statusFile = SOURCE_STATUS_FILE) {
  const next = {
    ...status,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  const tempFile = `${statusFile}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tempFile, statusFile);
  return next;
}

export function recordSourceLoginCheck(source, { required, reason = '', checkedAt }, statusFile = SOURCE_STATUS_FILE) {
  if (!LOGIN_SOURCES.includes(source)) return readSourceLoginStatus(statusFile);
  const status = readSourceLoginStatus(statusFile);
  status.sources[source] = {
    loginRequired: Boolean(required),
    reason: String(reason ?? ''),
    checkedAt: checkedAt ?? new Date().toISOString(),
  };
  return writeSourceLoginStatus(status, statusFile);
}

export function readLoginRequest(requestFile = LOGIN_REQUEST_FILE) {
  try {
    return JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  } catch {
    return null;
  }
}

export function writeLoginRequest(request, requestFile = LOGIN_REQUEST_FILE) {
  fs.mkdirSync(path.dirname(requestFile), { recursive: true });
  const tempFile = `${requestFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(request, null, 2));
  fs.renameSync(tempFile, requestFile);
}

export function createLoginRequest(source, requestFile = LOGIN_REQUEST_FILE) {
  const existing = readLoginRequest(requestFile);
  const now = Date.now();
  if (
    existing?.source === source &&
    ['requested', 'pending', 'qr_ready'].includes(existing.status) &&
    now - Number(existing.requestedAtMs ?? 0) < 10 * 60_000
  ) {
    return existing;
  }

  const request = {
    source,
    status: 'requested',
    requestedAt: new Date().toISOString(),
    requestedAtMs: now,
  };
  writeLoginRequest(request, requestFile);
  return request;
}
