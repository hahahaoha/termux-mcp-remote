// 一次性设备注册码。
//
// 设计要点（安全相关，改动请先读）：
//   1. 注册码里【不含任何密钥】。码本身只有 Worker 地址 + 32 字节随机数。
//      —— 地址是公开信息（任何人访问 /mcp 都只会拿到 401），随机数才是凭证。
//   2. Durable Object 里【只存码的 SHA-256 哈希】，不存明文。
//      即使有人拿到 DO 存储快照，也还原不出可用的码。
//   3. 真正的 authToken / agentToken 在【兑换的那一刻】由 Worker 从当前设置中
//      现取并注入，不落库。好处：轮换过 token 后，旧注册码兑换出来的也是新 token。
//   4. 一次性 + 过期即焚。兑换成功后记录标记 used，再次兑换返回 410；
//      过期后记录被删除，码再也解不出任何东西（这正是"过一段时间就不能复原"）。
const PREFIX = "code:";
const MAX_ACTIVE = 20;
const DEFAULT_TTL_SEC = 600;   // 10 分钟
const MAX_TTL_SEC = 3600;

export class EnrollStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try {
      switch (url.pathname) {
        case "/create": return await this.create(body);
        case "/redeem": return await this.redeem(body);
        case "/revoke": return await this.revoke(body);
        case "/list": return await this.list();
        default: return json({ ok: false, error: "not found" }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 400);
    }
  }

  // ---------------- 生成 ----------------
  async create({ ttlSec, hint } = {}) {
    await this.purge();
    const active = (await this.records()).filter((r) => !r.usedAt && r.expiresAt > Date.now());
    if (active.length >= MAX_ACTIVE) {
      return json({ ok: false, error: `同时有效的注册码最多 ${MAX_ACTIVE} 个，请先撤销不用的` }, 429);
    }

    const ttl = clampTtl(ttlSec);
    const code = randomCode();
    const hash = await sha256hex(code);
    const now = Date.now();
    const rec = {
      id: hash.slice(0, 12),
      hash,
      hint: String(hint || "").slice(0, 40),
      createdAt: now,
      expiresAt: now + ttl * 1000,
      ttlSec: ttl,
      usedAt: null,
      usedBy: null,
      usedName: null,
    };
    await this.state.storage.put(PREFIX + hash, rec);
    return json({
      ok: true,
      code,                       // 明文只在这一刻返回给浏览器，之后无处可查
      id: rec.id,
      expiresAt: rec.expiresAt,
      ttlSec: ttl,
    });
  }

  // ---------------- 兑换 ----------------
  // inject 由 Worker 在调用时注入（当前 workerUrl / authToken / agentToken），本 DO 不持久化
  async redeem({ code, deviceId, name, inject } = {}) {
    const clean = String(code || "").trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(clean)) {
      return json({ ok: false, code: "invalid", error: "注册码格式不正确" }, 400);
    }
    const hash = await sha256hex(clean);
    const rec = await this.state.storage.get(PREFIX + hash);
    if (!rec) {
      // 不存在 / 已过期被清理 / 已被撤销，都是同一个结果，避免探测
      return json({ ok: false, code: "notfound", error: "注册码无效、已过期或已被撤销" }, 404);
    }
    if (rec.usedAt) {
      return json({
        ok: false, code: "used",
        error: `注册码已被使用（${new Date(rec.usedAt).toLocaleString("zh-CN")}${rec.usedName ? " · " + rec.usedName : ""}）`,
      }, 410);
    }
    if (rec.expiresAt <= Date.now()) {
      await this.state.storage.delete(PREFIX + hash);
      return json({ ok: false, code: "expired", error: "注册码已过期，请重新生成" }, 410);
    }

    // 一次性：先标记，再返回
    rec.usedAt = Date.now();
    rec.usedBy = String(deviceId || "").slice(0, 64) || null;
    rec.usedName = String(name || "").slice(0, 64) || null;
    await this.state.storage.put(PREFIX + hash, rec);

    return json({
      ok: true,
      config: {
        workerUrl: inject?.workerUrl || "",
        authToken: inject?.authToken || "",
        agentToken: inject?.agentToken || "",
      },
      expiresAt: rec.expiresAt,
      hint: rec.hint,
    });
  }

  async revoke({ id }) {
    const target = String(id || "");
    if (!target) return json({ ok: false, error: "缺少 id" }, 400);
    let n = 0;
    for (const [key, rec] of await this.state.storage.list({ prefix: PREFIX })) {
      if (rec.id === target) {
        await this.state.storage.delete(key);
        n++;
      }
    }
    return json({ ok: n > 0, revoked: n, error: n ? undefined : "没有找到该注册码" });
  }

  async list() {
    await this.purge();
    const now = Date.now();
    const items = (await this.records())
      .map((r) => ({
        id: r.id,
        hint: r.hint,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        usedAt: r.usedAt,
        usedName: r.usedName,
        usedBy: r.usedBy,
        state: r.usedAt ? "used" : r.expiresAt <= now ? "expired" : "active",
        remainingSec: r.usedAt ? 0 : Math.max(0, Math.round((r.expiresAt - now) / 1000)),
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);
    return json({ ok: true, items });
  }

  async records() {
    const out = [];
    for (const [, rec] of await this.state.storage.list({ prefix: PREFIX })) out.push(rec);
    return out;
  }

  // 清理：过期的直接删；已使用的保留 1 小时方便页面显示"已使用"
  async purge() {
    const now = Date.now();
    let n = 0;
    for (const [key, rec] of await this.state.storage.list({ prefix: PREFIX })) {
      const dead = rec.usedAt ? now - rec.usedAt > 3600_000 : rec.expiresAt <= now;
      if (dead) {
        await this.state.storage.delete(key);
        n++;
      }
    }
    return n;
  }
}

// ---------------- 工具 ----------------

function clampTtl(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SEC;
  return Math.min(Math.max(Math.round(n), 60), MAX_TTL_SEC);
}

function randomCode() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToB64url(b);
}

function bytesToB64url(bytes) {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
