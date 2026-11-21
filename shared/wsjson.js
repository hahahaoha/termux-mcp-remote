// Worker 与 Termux Agent 共用的 WebSocket JSON 分块传输层。
// 目的：Cloudflare 单条 WebSocket 消息上限 1MiB，大文件/大输出必须切片。
// 依赖：TextEncoder/TextDecoder、btoa/atob（Node 18+ 与 Workers 都有）。

export const MAX_FRAME_BYTES = 256 * 1024;   // 单片原始字节上限（base64 后约 341KB，安全）
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // 单条消息拼接后的上限
const CHUNK_TTL_MS = 120 * 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();

// Worker 的 WebSocket 单帧上限是 1MiB，256KB 原始数据 base64 后约 341KB，留足余量
export function b64FromBytes(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

export function bytesFromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function concatBytes(parts, total) {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

let chunkSeq = 0;

// 发送任意 JSON 对象；超过 MAX_FRAME_BYTES 自动切片
export function sendJSON(ws, obj) {
  const text = JSON.stringify(obj);
  const bytes = enc.encode(text);
  if (bytes.length <= MAX_FRAME_BYTES) {
    ws.send(text);
    return;
  }
  const id = `c${Date.now().toString(36)}${(++chunkSeq).toString(36)}`;
  const n = Math.ceil(bytes.length / MAX_FRAME_BYTES);
  for (let i = 0; i < n; i++) {
    const slice = bytes.subarray(i * MAX_FRAME_BYTES, Math.min((i + 1) * MAX_FRAME_BYTES, bytes.length));
    ws.send(JSON.stringify({
      __chunk: { id, i, n },
      data: b64FromBytes(slice),
    }));
  }
}

// 返回一个接收函数：handle(data) → 完整消息对象或 null（还在拼接）
export function createAssembler(onMessage, onError) {
  const pending = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, item] of pending) {
      if (now - item.at > CHUNK_TTL_MS) { pending.delete(id); onError?.(new Error("分块消息超时")); }
    }
  }, 30000);
  timer.unref?.();

  return function handle(data) {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = dec.decode(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) text = dec.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    else text = String(data);

    let msg;
    try { msg = JSON.parse(text); } catch (e) { onError?.(new Error("收到非 JSON 消息")); return null; }

    if (!msg || typeof msg !== "object" || !msg.__chunk) {
      onMessage(msg);
      return msg;
    }
    const { id, i, n } = msg.__chunk;
    if (typeof id !== "string" || !Number.isInteger(i) || !Number.isInteger(n) || n <= 0 || n > 4096 || i < 0 || i >= n) {
      onError?.(new Error("分块头非法"));
      return null;
    }
    let item = pending.get(id);
    if (!item) {
      item = { parts: new Array(n), got: 0, size: 0, at: Date.now() };
      pending.set(id, item);
    }
    if (!item.parts[i]) {
      const part = bytesFromB64(String(msg.data || ""));
      item.parts[i] = part;
      item.got++;
      item.size += part.length;
      if (item.size > MAX_MESSAGE_BYTES) {
        pending.delete(id);
        onError?.(new Error("分块消息超过大小上限"));
        return null;
      }
    }
    item.at = Date.now();
    if (item.got === n) {
      pending.delete(id);
      const full = concatBytes(item.parts, item.size);
      let out;
      try { out = JSON.parse(dec.decode(full)); } catch (e) { onError?.(new Error("分块消息 JSON 解析失败")); return null; }
      onMessage(out);
      return out;
    }
    return null;
  };
}
