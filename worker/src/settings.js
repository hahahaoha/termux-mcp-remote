// 运行时配置（可在 WebUI 里改，不需要重新部署）
// 存 Durable Object storage；优先级：DO 里保存的值 > Worker 环境变量/Secret。
// 这样在网页上就能轮换 token，不用再跑 wrangler。
const KEY = "runtimeConfig";

export class Settings {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async get() {
    const saved = (await this.state.storage.get(KEY)) || {};
    return {
      authToken: saved.authToken || this.env.AUTH_TOKEN || "",
      agentToken: saved.agentToken || this.env.AGENT_TOKEN || "",
      defaultDevice: saved.defaultDevice ?? null,
      updatedAt: saved.updatedAt || null,
      authFrom: saved.authToken ? "webui" : "secret",
      agentFrom: saved.agentToken ? "webui" : "secret",
    };
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/get") return json(await this.publicView());
    if (url.pathname === "/set" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const saved = (await this.state.storage.get(KEY)) || {};
      if (typeof body.authToken === "string" && body.authToken) saved.authToken = body.authToken;
      if (typeof body.agentToken === "string" && body.agentToken) saved.agentToken = body.agentToken;
      if (body.defaultDevice !== undefined) saved.defaultDevice = body.defaultDevice || null;
      saved.updatedAt = Date.now();
      await this.state.storage.put(KEY, saved);
      return json(await this.publicView());
    }
    if (url.pathname === "/reset" && req.method === "POST") {
      await this.state.storage.delete(KEY);
      return json(await this.publicView());
    }
    return json({ ok: false, error: "not found" }, 404);
  }

  // 给 WebUI 看的视图：token 明文返回（调用方已用 token 鉴权过）
  async publicView() {
    const c = await this.get();
    return {
      ok: true,
      authToken: c.authToken,
      agentToken: c.agentToken,
      defaultDevice: c.defaultDevice,
      authFrom: c.authFrom,
      agentFrom: c.agentFrom,
      updatedAt: c.updatedAt,
    };
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
