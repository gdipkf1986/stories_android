// njs（nginx JavaScript）认证模块：签发（/auth/login）+ 校验（$auth_ok、/auth/verify）
//
// JWT 算法: HS256；密钥来自容器环境变量 JWT_SECRET（nginx.conf main 上下文用 env 指令
// 暴露给 njs 的 process.env）。密钥与访问口令只存在于服务端环境变量，
// 绝不写入代码仓库、日志或任何 API 响应。
import crypto from 'crypto';

const TOKEN_TTL_SECONDS = 30 * 24 * 3600; // token 有效期 30 天
const COOKIE_NAME = 'jovijwt';

// ── base64url（JWT header/payload 均为受控 ASCII，btoa/atob 按 latin1 处理恰好正确） ──
function b64Tob64u(s) {
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uTob64(s) {
    return (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
}

// ASCII → base64url
function b64uEncode(ascii) {
    return b64Tob64u(btoa(ascii));
}

// base64url → ASCII 字符串（可直接 JSON.parse）
function b64uDecode(part) {
    return atob(b64uTob64(part));
}

function hmacB64u(data, secret) {
    return b64Tob64u(crypto.createHmac('sha256', secret).update(data).digest('base64'));
}

// ── 常量时间比较（口令与签名都用它） ──
function safeEq(a, b) {
    const ab = String(a);
    const bb = String(b);
    if (ab.length !== bb.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < ab.length; i++) {
        diff |= ab.charCodeAt(i) ^ bb.charCodeAt(i);
    }
    return diff === 0;
}

// ── JWT ──
const JWT_HEADER = b64uEncode('{"alg":"HS256","typ":"JWT"}');

function signJwt(secret, sub, ttlSeconds) {
    const now = Math.floor(Date.now() / 1000);
    const payload = b64uEncode(JSON.stringify({ sub: sub, iat: now, exp: now + ttlSeconds }));
    const data = JWT_HEADER + '.' + payload;
    return data + '.' + hmacB64u(data, secret);
}

function verifyJwt(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3) {
        return false;
    }
    const h = parts[0];
    const p = parts[1];
    const s = parts[2];

    // 显式只接受 HS256，拒绝 alg:none / 其他算法
    let head;
    try {
        head = JSON.parse(b64uDecode(h));
    } catch (e) {
        return false;
    }
    if (!head || head.alg !== 'HS256') {
        return false;
    }

    // 签名一致性
    if (!safeEq(s, hmacB64u(h + '.' + p, secret))) {
        return false;
    }

    // 有效期
    let payload;
    try {
        payload = JSON.parse(b64uDecode(p));
    } catch (e) {
        return false;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) {
        return false;
    }
    return true;
}

// ── 从请求提取 token：Authorization: Bearer 优先，其次 Cookie jovijwt ──
function extractToken(r) {
    const authz = r.headersIn['Authorization'];
    if (authz) {
        const m = String(authz).match(/^Bearer\s+(\S+)$/i);
        if (m) {
            return m[1];
        }
    }
    const cookie = r.headersIn['Cookie'];
    if (cookie) {
        const m = String(cookie).match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;\\s]+)'));
        if (m) {
            return m[1];
        }
    }
    return '';
}

// js_set：同步校验。受保护 location 里 `if ($auth_ok = 0)` 分流
function check(r) {
    const secret = process.env.JWT_SECRET || '';
    if (!secret) {
        r.log('auth: JWT_SECRET 未配置，拒绝访问（fail closed）');
        return 0;
    }
    const token = extractToken(r);
    return token && verifyJwt(token, secret) ? 1 : 0;
}

// POST /auth/login：校验口令 → 签发 JWT → Set-Cookie + JSON
function login(r) {
    if (r.method !== 'POST') {
        r.return(405, 'method not allowed');
        return;
    }
    const secret = process.env.JWT_SECRET || '';
    const password = process.env.AUTH_PASSWORD || '';
    if (!secret || !password) {
        r.log('auth: JWT_SECRET / AUTH_PASSWORD 未配置');
        r.return(500, 'auth not configured');
        return;
    }

    let input = '';
    try {
        input = String(JSON.parse(r.requestText).password || '');
    } catch (e) {
        // body 非法按空密码处理
    }
    if (!input || !safeEq(input, password)) {
        r.return(401, 'unauthorized');
        return;
    }

    const token = signJwt(secret, 'stories', TOKEN_TTL_SECONDS);
    r.headersOut['Content-Type'] = 'application/json';
    r.headersOut['Set-Cookie'] = COOKIE_NAME + '=' + token
        + '; Path=/; Max-Age=' + TOKEN_TTL_SECONDS + '; HttpOnly; Secure; SameSite=Lax';
    r.return(200, JSON.stringify({ token: token, tokenType: 'Bearer', expiresIn: TOKEN_TTL_SECONDS }));
}

// internal /auth/verify：独立校验端点（本地 curl 调试 / 健康检查用）
function verify(r) {
    r.return(check(r) === 1 ? 200 : 401);
}

export default { check, login, verify };
