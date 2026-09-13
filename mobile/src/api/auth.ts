import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from './config';

const TOKEN_KEY = 'stories.jwt';

/** 读取本地保存的 JWT（没有则为 null） */
export async function getToken(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function setToken(token: string | null): Promise<void> {
  try {
    if (token) {
      await AsyncStorage.setItem(TOKEN_KEY, token);
    } else {
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // 存储失败不阻塞登录流程
  }
}

/** 用访问密码登录：成功后 token 持久化，之后所有请求自动带 Authorization: Bearer */
export async function login(password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? '密码错误'
        : res.status === 429
          ? '尝试过于频繁，请稍后再试'
          : `登录失败（HTTP ${res.status}）`,
    );
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new Error('登录响应缺少 token');
  }
  await setToken(data.token);
}

/** 退出登录（清除本地 token；下次请求会重新 401 → 回到登录页） */
export async function logout(): Promise<void> {
  await setToken(null);
}
