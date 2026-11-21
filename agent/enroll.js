// 一次性注册码：把「地址 + 密钥」压缩成一段可以直接粘贴的码。
//
// 安全模型（务必理解）：
//   - 码里只有 Worker 地址和随机数；密钥不落库，兑换时由 Worker 现取注入。
//   - 服务端只存 SHA-256 哈希，且一次性、默认 10 分钟过期。
//   - 兑换成功后立刻作废，重复兑换返回 410。
//   - 过期后记录被删除，码再也解不出任何东西。
import { loadConfig, saveConfig, normalizeUrl, isConfigured } from "./config.js";

const ENROLL_RE = /^[A-Za-z0-9_-]{20,200}$/;

// 从任意文本里提取注册码（允许粘贴时带空格/换行/引号）
export function extractCode(raw) {
  const s = String(raw || "").trim().replace(/^["'`]|["'`]$/g, "");
  if (ENROLL_RE.test(s)) return s;
  // 也允许 "tmcp enroll <code>" 或 URL 形式
  const m = /(?:enroll[\/\s]+|code=)([A-Za-z0-9_-]{20,200})/.exec(s);
  return m ? m[1] : "";
}

export function looksLikeCode(raw) {
  return !!extractCode(raw);
}

// 用注册码向 Worker 兑换配置。返回 { ok, config } 或抛错
export async function redeemCode({ code, workerUrl, name, deviceId, signal }) {
  const cleaned = extractCode(code);
  if (!cleaned) throw new Error("这不像一个注册码（长度或字符不合法）");
  const base = normalizeUrl(workerUrl);
  if (!base) throw new Error("需要先知道 Worker 地址：tmcp enroll <地址> <注册码>");

  const r = await fetch(`${base}/api/enroll/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: cleaned, name: name || "", deviceId: deviceId || "" }),
    signal: signal || AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) {
    const e = new Error(j.error || `兑换失败（HTTP ${r.status}）`);
    e.reason = j.code || "unknown";
    throw e;
  }
  const cfg = j.config || {};
  if (!cfg.workerUrl || !cfg.authToken || !cfg.agentToken) {
    throw new Error("Worker 返回的配置不完整，可能是版本不匹配");
  }
  return cfg;
}

// 兑换并写盘
export async function enrollAndSave({ code, workerUrl, name, deviceId }) {
  const got = await redeemCode({ code, workerUrl, name, deviceId });
  const prev = loadConfig();
  const next = saveConfig({
    ...prev,
    workerUrl: got.workerUrl,
    authToken: got.authToken,
    agentToken: got.agentToken,
    name: name || prev.name,
    deviceId: deviceId || prev.deviceId,
    enrolledAt: Date.now(),
  });
  return next;
}
