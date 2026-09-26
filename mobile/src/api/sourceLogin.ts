import { API_BASE } from './config';
import { getToken } from './auth';
import type { SourceId, SourceLoginSession, SourceLoginStatus } from '../types';

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchSourceLoginStatus(): Promise<Partial<Record<SourceId, SourceLoginStatus>>> {
  const res = await fetch(`${API_BASE}/api/source-login/status`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { sources?: Partial<Record<SourceId, SourceLoginStatus>> };
  return data.sources ?? {};
}

export async function requestSourceLogin(source: SourceId): Promise<number> {
  const res = await fetch(`${API_BASE}/api/source-login`, {
    method: 'POST',
    headers: {
      ...(await authHeaders()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ source }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { request?: { requestedAtMs?: number } };
  return data.request?.requestedAtMs ?? Date.now();
}

export async function fetchSourceLoginSession(source: SourceId, sinceMs: number): Promise<SourceLoginSession> {
  const query = new URLSearchParams({ source, since: String(sinceMs) });
  const res = await fetch(`${API_BASE}/api/source-login/session?${query}`, {
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as SourceLoginSession;
}
