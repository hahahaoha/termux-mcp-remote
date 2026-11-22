// 一次性注册码：把「地址 + 密钥」压缩成一段可以直接粘贴的码。
//
// 安全模型（务必理解）：
//   - 码里只有 Worker 地址和随机数；密钥不落库，兑换时由 Worker 现取注入。
//   - 服务端只存 SHA-256 哈希，且一次性、默认 10 分钟过期。
//   - 兑换成功后立刻作废，重复兑换返回 410。
//   - 过期后记录被删除，码再也解不出任何东西。
import { loadConfig, saveConfig, normalizeUrl, isConfigured } from "./config.js";
import { fetchRetry, explainError } from "./net.js";

const ENROLL_RE = /^[A-Za-z0-9_-]{20,200}$/;
const LINK_PREFIX = "tmcp1_";

// 解析粘贴进来的东西。两种情况都支持：
//   tmcp1_xxx          自包含码：解出 Worker 地址 + 随机码，一次粘贴搞定
//   xxxxxxxxxxxx       裸码：只有随机码，需要另外提供地址（兼容旧码）
export function parseEnroll(raw) {
  let s = String(raw || "").trim().replace(/^["'`]|["'`]$/g, "");
  // 粘贴时常带上换行/空格，先去掉
  s = s.replace(/\s+/g, "");

  if (s.startsWith(LINK_PREFIX)) {
    try {
      const json = Buffer.from(s.slice(LINK_PREFIX.length), "base64url").toString("utf8");
      const o = JSON.parse(json);
      if (o && typeof o.c === "string" && typeof o.h === "string") {
        return { code: o.c, workerUrl: o.h, selfContained: true };
      }
    } catch { }
    return { code: "", workerUrl: "", selfContained: true, broken: true };
  }

  if (ENROLL_RE.test(s)) return { code: s, workerUrl: "", selfContained: false };

  // 也允许 "tmcp enroll <code>" 之类
  const m = /(?:enroll[\/\s]+|code=)([A-Za-z0-9_-]{20,200})/.exec(s);
  return { code: m ? m[1] : "", workerUrl: "", selfContained: false };
}

// 从任意文本里提取注册码（兼容旧调用）
export function extractCode(raw) {
  return parseEnroll(raw).code;
}

export function looksLikeCode(raw) {
  return !!extractCode(raw);
}

// 用注册码向 Worker 兑换配置。返回 { ok, config } 或抛错
export async function redeemCode({ code, workerUrl, name, deviceId, signal }) {
  const parsed = parseEnroll(code);
  if (parsed.broken) throw new Error("配置码不完整，可能复制时漏了字符，请重新复制");
  const cleaned = parsed.code;
  if (!cleaned) throw new Error("这不像一个配置码（长度或字符不合法）");
  // 地址优先级：显式传入 > 码里自带的
  const base = normalizeUrl(workerUrl) || normalizeUrl(parsed.workerUrl);
  if (!base) throw new Error("需要先知道 Worker 地址：tmcp enroll <地址> <注册码>");

  const r = await fetchRetry(`${base}/api/enroll/redeem`, {
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
