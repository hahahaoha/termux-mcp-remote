// 网络辅助：把 Node fetch 那句没头没尾的 "fetch failed" 变成能看懂的原因，
// 并且处理几个容器的常见坑（IPv6 有 AAAA 但没有路由）。
import dns from "node:dns";

// 很多容器/VPS 能查到 AAAA 但没有 IPv6 出口，Node 默认会先试 IPv6 然后失败。
// 这里统一改成 IPv4 优先。
export function preferIPv4() {
  try {
    dns.setDefaultResultOrder("ipv4first");
  } catch { /* 老版本 Node 没有这个 API，忽略 */ }
}

// 把 fetch 抛的错误翻译成人话
export function explainError(e, url = "") {
  const cause = e?.cause || {};
  const code = cause.code || e?.code || "";
  const target = url || "";

  const map = {
    ENOTFOUND: "DNS 解析失败：找不到这个域名。检查网络，或把 DNS 改成 223.5.5.5 / 1.1.1.1",
    EAI_AGAIN: "DNS 暂时解析不了。稍后重试，或换一个 DNS",
    ECONNREFUSED: "对方拒绝连接：端口没开或被墙",
    ECONNRESET: "连接被重置（常见于中间设备干扰）",
    ETIMEDOUT: "连接超时",
    UND_ERR_CONNECT_TIMEOUT: "连接超时",
    UND_ERR_SOCKET: "连接中断",
    ENETUNREACH: "网络不可达（可能是 IPv6 没有出口）",
    EHOSTUNREACH: "主机不可达",
    CERT_HAS_EXPIRED: "HTTPS 证书已过期",
    DEPTH_ZERO_SELF_SIGNED_CERT: "HTTPS 证书不受信任（自签名）",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "HTTPS 证书链不完整",
    SELF_SIGNED_CERT_IN_CHAIN: "HTTPS 证书链里有自签名证书",
  };

  const hint = map[code];
  const base = e?.message || String(e);
  if (hint) return target ? `${hint}（${target}）` : hint;
  if (cause.message && cause.message !== base) {
    return target ? `${base}: ${cause.message}（${target}）` : `${base}: ${cause.message}`;
  }
  return target ? `${base}（${target}）` : base;
}

const RETRYABLE = new Set([
  "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET", "ENETUNREACH", "EHOSTUNREACH",
]);

function isRetryable(e) {
  const code = e?.cause?.code || e?.code || "";
  if (RETRYABLE.has(code)) return true;
  // 超时/中断类也重试一次
  return /fetch failed|network|timeout/i.test(String(e?.message || ""));
}

// 带重试的 fetch：网络抖动时多试两次，失败时抛出带原因的错误
export async function fetchRetry(url, init = {}, { retries = 2, delayMs = 700 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      if (i === retries || !isRetryable(e)) break;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  const err = new Error(explainError(last, url));
  err.cause = last?.cause || last;
  err.network = true;
  throw err;
}
