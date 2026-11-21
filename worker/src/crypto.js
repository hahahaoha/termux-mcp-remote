// 定长比较，避免时序侧信道
export function checkToken(given, expected) {
  if (!expected || !given) return false;
  const a = new TextEncoder().encode(String(given));
  const b = new TextEncoder().encode(String(expected));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
