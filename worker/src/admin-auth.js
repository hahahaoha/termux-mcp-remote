// 后台登录口令与会话。
//
// 和 MCP 凭证彻底分开：
//   - AUTH_TOKEN     ：给 AI 客户端用的 API 凭证，长字符串，只走 Authorization 头
//   - AGENT_TOKEN    ：设备连 Worker 用，从不在浏览器里出现
//   - ADMIN_PASSWORD ：只用于登录 /admin 后台，短口令，人记；服务端只存 PBKDF2 哈希
//   - 会话            ：登录成功后签发的 HttpOnly cookie，与上面三者都不同
//
// 首次访问 /admin 若没设过后台密码，会引导设置一个；之后只能用密码登录。
// 忘记密码可在设备上执行 `tmcp admin-pass` 重设（直接写 Worker，不需要旧密码）。

const KEY = "adminAuth";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILS = 8;
const LOCK_MS = 10 * 60 * 1000;
// Cloudflare Workers 的 PBKDF2 上限是 100000，超过会抛错
const PBKDF2_ITERATIONS = 100_000;

export class AdminAuth {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try {
      switch (url.pathname) {
        case "/status": return json(await this.status());
        case "/setup": return await this.setup(body);
        case "/login": return await this.login(body, req);
        case "/logout": return await this.logout(body, req);
        case "/verify": return json(await this.verify(body.session));
        case "/reset": return await this.reset(body);
        default: return json({ ok: false, error: "not found" }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  async load() {
    return (await this.state.storage.get(KEY)) || { hash: null, salt: null, iterations: 0, sessions: {}, fails: 0, lockedUntil: 0, updatedAt: null };
  }

  async save(rec) {
    await this.state.storage.put(KEY, rec);
  }

  async status() {
    const rec = await this.load();
    return {
      ok: true,
      configured: !!rec.hash,
      updatedAt: rec.updatedAt,
      // 只在"从没设过"时告诉前端可以初始化；一旦设过，重置必须走 CLI
      canSetup: !rec.hash,
      locked: (rec.lockedUntil || 0) > Date.now(),
    };
  }

  // 首次设置后台密码（仅当从未设置过）
  async setup({ password }) {
    const rec = await this.load();
    if (rec.hash) return json({ ok: false, error: "后台密码已设置过。忘记请用 tmcp admin-pass 重设。" }, 409);
    const err = validatePassword(password);
    if (err) return json({ ok: false, error: err }, 400);
    const { hash, salt } = await hashPassword(password, PBKDF2_ITERATIONS);
    rec.hash = hash;
    rec.salt = salt;
    rec.iterations = PBKDF2_ITERATIONS;
    rec.sessions = {};
    rec.updatedAt = Date.now();
    await this.save(rec);
    return await this.newSession(rec, "设置成功");
  }

  async login({ password }, req) {
    const rec = await this.load();
    if (!rec.hash) return json({ ok: false, error: "还没设置后台密码", needSetup: true }, 409);
    if ((rec.lockedUntil || 0) > Date.now()) {
      const min = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
      return json({ ok: false, error: `尝试次数过多，请 ${min} 分钟后再试` }, 429);
    }
    const ok = await verifyPassword(String(password || ""), rec);
    if (!ok) {
      rec.fails = (rec.fails || 0) + 1;
      if (rec.fails >= MAX_FAILS) {
        rec.lockedUntil = Date.now() + LOCK_MS;
        rec.fails = 0;
      }
      await this.save(rec);
      return json({ ok: false, error: "密码不正确" }, 401);
    }
    rec.fails = 0;
    rec.lockedUntil = 0;
    await this.save(rec);
    return await this.newSession(rec, "登录成功");
  }

  async newSession(rec, message) {
    const token = randomHex(32);
    rec.sessions = rec.sessions || {};
    // 清掉过期的
    const now = Date.now();
    for (const [k, v] of Object.entries(rec.sessions)) {
      if (!v || v.expiresAt < now) delete rec.sessions[k];
    }
    // 限制会话数，避免无限增长
    const ids = Object.keys(rec.sessions);
    if (ids.length >= 12) {
      ids.sort((a, b) => (rec.sessions[a].createdAt || 0) - (rec.sessions[b].createdAt || 0));
      for (const k of ids.slice(0, ids.length - 11)) delete rec.sessions[k];
    }
    rec.sessions[token] = { createdAt: now, expiresAt: now + SESSION_TTL_MS };
    await this.save(rec);
    return withCookie(
      json({ ok: true, message, expiresAt: now + SESSION_TTL_MS }),
      buildCookie(token)
    );
  }

  async logout({ session }, req) {
    const rec = await this.load();
    const token = session || readSessionCookie(req);
    if (token && rec.sessions?.[token]) {
      delete rec.sessions[token];
      await this.save(rec);
    }
    return withCookie(json({ ok: true }), buildCookie("", 0));
  }

  async verify(session) {
    if (!session) return { ok: false };
    const rec = await this.load();
    const s = rec.sessions?.[session];
    if (!s) return { ok: false };
    if (s.expiresAt < Date.now()) {
      delete rec.sessions[session];
      await this.save(rec);
      return { ok: false, expired: true };
    }
    return { ok: true, expiresAt: s.expiresAt };
  }

  // CLI 用：直接重设密码（携带 AGENT_TOKEN 或 AUTH_TOKEN 以证明是主人）
  // password 传空字符串 = 清除后台密码，下次打开 /admin 会重新引导设置
  async reset({ password }) {
    if (password === "" || password === null) {
      await this.state.storage.delete(KEY);
      return json({ ok: true, message: "后台密码已清除，下次访问 /admin 会重新引导设置" });
    }
    const err = validatePassword(password);
    if (err) return json({ ok: false, error: err }, 400);
    const { hash, salt } = await hashPassword(password, PBKDF2_ITERATIONS);
    const rec = await this.load();
    rec.hash = hash;
    rec.salt = salt;
    rec.iterations = PBKDF2_ITERATIONS;
    rec.sessions = {};
    rec.fails = 0;
    rec.lockedUntil = 0;
    rec.updatedAt = Date.now();
    await this.save(rec);
    return json({ ok: true, message: "后台密码已重设，所有会话已失效" });
  }
}

// ---------- 密码哈希 ----------

function validatePassword(pw) {
  const s = String(pw || "");
  if (s.length < 8) return "密码至少 8 位";
  if (s.length > 200) return "密码太长";
  return null;
}

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hashPassword(password, iterations, saltB64) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
  return { hash: toB64(bits), salt: toB64(salt) };
}

async function verifyPassword(password, rec) {
  if (!rec.hash || !rec.salt) return false;
  const { hash } = await hashPassword(password, rec.iterations || PBKDF2_ITERATIONS, rec.salt);
  return timingSafeEqualStr(hash, rec.hash);
}

// 定长比较（先哈希成等长串再比，避免长度泄漏）
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const la = a.length, lb = b.length;
  let diff = la ^ lb;
  for (let i = 0; i < Math.max(la, lb); i++) {
    diff |= (a.charCodeAt(i % (la || 1)) || 0) ^ (b.charCodeAt(i % (lb || 1)) || 0);
  }
  return diff === 0;
}

// 后台是 https，Secure 必加；SameSite=Strict 防 CSRF
function buildCookie(token, maxAgeSec = Math.floor(SESSION_TTL_MS / 1000)) {
  const base = `tmcp_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
  return base;
}

// DO → Worker 之间 Set-Cookie 会透传，但为了保险同时暴露给 JS（body 里不再带 session）
function withCookie(res, cookie) {
  const headers = new Headers(res.headers);
  headers.append("set-cookie", cookie);
  return new Response(res.body, { status: res.status, headers });
}

function readSessionCookie(req) {
  const header = req?.headers?.get?.("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "tmcp_admin") return rest.join("=") || "";
  }
  return "";
}

function randomHex(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
