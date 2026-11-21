// Cloudflare API：读取 wrangler 的本地登录凭据，用于「绑定自定义域名」等 wrangler 不太顺手的操作。
// 只读取 ~/.config/.wrangler/config/default.toml 里的 OAuth token，不做任何持久化。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API = "https://api.cloudflare.com/client/v4";

export function readWranglerAuth() {
  const candidates = [
    path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".wrangler", "config", "default.toml"),
  ];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, "utf8");
      const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(text)?.[1];
      if (token) return { token, path: p };
    } catch { }
  }
  return null;
}

async function api(token, method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const msg = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json.result;
}

export async function listAccounts(token) {
  return api(token, "GET", "/accounts?per_page=50");
}

export async function listZones(token) {
  return api(token, "GET", "/zones?per_page=50");
}

// 给 Worker 绑定自定义域名（Cloudflare 会自动创建 DNS 记录和证书）
export async function attachWorkerDomain(token, { accountId, zoneId, hostname, service }) {
  return api(token, "PUT", `/accounts/${accountId}/workers/domains`, {
    environment: "production",
    hostname,
    service,
    zone_id: zoneId,
  });
}

export async function listWorkerDomains(token, accountId) {
  return api(token, "GET", `/accounts/${accountId}/workers/domains`);
}

// 检查某个主机名是否已解析到 Cloudflare（粗略判断，够用）
export async function resolveHost(hostname) {
  const dns = await import("node:dns/promises");
  try {
    const v4 = await dns.resolve4(hostname).catch(() => []);
    const v6 = await dns.resolve6(hostname).catch(() => []);
    return { v4, v6 };
  } catch {
    return { v4: [], v6: [] };
  }
}
