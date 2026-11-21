// 平台探测：同一套 Agent 要能跑在 Termux(Android) / Debian / Ubuntu / 其他 Linux。
// 不依赖任何平台专属命令；取不到就回退到通用值。
//
// 注意 Android 的几个坑：
//   - os.cpus() 返回空数组（/proc/cpuinfo 对应用不可见）
//   - os.loadavg() 恒为 [0,0,0]（内核没导出 /proc/loadavg）
//   - os.hostname() 恒为 "localhost"
//   - os.freemem() 只算 MemFree，不含可回收的 cache，数值明显偏低
// 这里都做了回退，取不到就把字段设成 null 而不是给个误导性的 0。
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

let cache = null;

// ARM 核心型号（/proc/cpuinfo 的 "CPU part" 字段）
const ARM_PART = {
  "0xd03": "Cortex-A53",
  "0xd04": "Cortex-A35",
  "0xd05": "Cortex-A55",
  "0xd07": "Cortex-A57",
  "0xd08": "Cortex-A72",
  "0xd09": "Cortex-A73",
  "0xd0a": "Cortex-A75",
  "0xd0b": "Cortex-A76",
  "0xd0c": "Neoverse-N1",
  "0xd0d": "Cortex-A77",
  "0xd40": "Cortex-A76",   // 部分麒麟 990 的写法
  "0xd41": "Cortex-A78",
  "0xd44": "Cortex-X1",
  "0xd46": "Cortex-A510",
  "0xd47": "Cortex-A710",
  "0xd48": "Cortex-X2",
  "0xd4d": "Cortex-A715",
  "0xd4e": "Cortex-X3",
};

function readFile(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

// CPU 核心数：优先 os.cpus()，Android 上回退到 nproc / sysfs
function cpuCount() {
  const fromNode = os.cpus()?.length || 0;
  if (fromNode > 0) return fromNode;
  try {
    const r = spawnSync("nproc", [], { encoding: "utf8", timeout: 3000 });
    const n = parseInt((r.stdout || "").trim(), 10);
    if (Number.isInteger(n) && n > 0) return n;
  } catch { }
  const online = readFile("/sys/devices/system/cpu/online").trim();
  const m = /^(\d+)-(\d+)$/.exec(online);
  if (m) return Number(m[2]) - Number(m[1]) + 1;
  try {
    return fs.readdirSync("/sys/devices/system/cpu").filter((d) => /^cpu\d+$/.test(d)).length || null;
  } catch { return null; }
}

// CPU 型号描述：x86 用 model name；ARM 用 CPU part 翻译成核心名
function cpuModel() {
  const info = readFile("/proc/cpuinfo");
  const x86 = /^model name\s*:\s*(.+)$/m.exec(info);
  if (x86) return x86[1].trim();
  const hw = /^Hardware\s*:\s*(.+)$/m.exec(info);
  if (hw) return hw[1].trim();
  // Android/ARM：CPU part 有多个值，说明是大小核
  const parts = [...info.matchAll(/^CPU part\s*:\s*(0x[0-9a-fA-F]+)/gm)].map((m) => m[1].toLowerCase());
  if (!parts.length) return null;
  const names = [...new Set(parts.map((p) => ARM_PART[p] || p))];
  return names.length > 1 ? `${names.join(" + ")} (big.LITTLE)` : names[0];
}

// 可用内存：优先 MemAvailable（含可回收 cache），比 os.freemem() 准
function memInfo() {
  const text = readFile("/proc/meminfo");
  const get = (k) => {
    const m = new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, "m").exec(text);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  };
  const total = get("MemTotal");
  const avail = get("MemAvailable");
  const free = get("MemFree");
  return {
    totalMemMB: total ?? Math.round(os.totalmem() / 1048576),
    freeMemMB: avail ?? free ?? Math.round(os.freemem() / 1048576),
  };
}

function deviceNameFromProp() {
  const fromEnv = process.env.TERMUX__DEVICE_MODEL;
  if (fromEnv) return fromEnv;
  try {
    const r = spawnSync("getprop", ["ro.product.model"], { encoding: "utf8", timeout: 3000 });
    const m = (r.stdout || "").trim();
    if (m) return m.replace(/\s+/g, "-");
  } catch { }
  return "";
}

export function detectPlatform() {
  if (cache) return cache;
  const isAndroid = process.platform === "android" || !!process.env.TERMUX_VERSION;
  const isTermux = !!process.env.TERMUX_VERSION || fs.existsSync("/data/data/com.termux");
  let distro = "";
  try {
    const rel = readFile("/etc/os-release");
    distro = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1] || "";
  } catch { }
  if (!distro && isAndroid) distro = "Android";

  cache = {
    os: isAndroid ? "android" : process.platform, // linux / android / darwin
    isAndroid,
    isTermux,
    distro,                        // "Debian GNU/Linux 12 (bookworm)" / "Android"
    arch: os.arch(),
    kernel: os.release(),
    // Android 上 hostname 恒为 localhost，没有辨识度；用机型代替
    hostname: isAndroid ? (deviceNameFromProp() || os.hostname()) : os.hostname(),
    hostnameRaw: os.hostname(),
    node: process.version,
    cpuCount: cpuCount(),
    cpuModel: cpuModel(),
  };
  return cache;
}

// 设备名：优先环境变量，Android 取机型，其他系统取主机名
export function deviceName() {
  if (process.env.TMCP_DEVICE_NAME) return process.env.TMCP_DEVICE_NAME;
  const p = detectPlatform();
  if (p.isAndroid) {
    const m = deviceNameFromProp();
    if (m) return m;
  }
  return p.hostname || "device";
}

// 系统信息（给 system_info 工具用），跨平台。
// 取不到的字段返回 null，不用 0 冒充（避免 AI 误判机器空闲/满载）。
export function systemInfo() {
  const p = detectPlatform();
  const mem = memInfo();

  // Android 内核不导出 /proc/loadavg，os.loadavg() 会返回 [0,0,0] 这种假数据
  let loadavg = null;
  if (!p.isAndroid) {
    const la = os.loadavg();
    if (la.some((n) => n > 0)) loadavg = la.map((n) => Math.round(n * 100) / 100);
  }

  const info = {
    device: deviceName(),
    os: p.os,
    distro: p.distro || null,
    arch: p.arch,
    kernel: p.kernel,
    hostname: p.hostname,
    node: p.node,
    cpuCount: p.cpuCount,
    cpuModel: p.cpuModel,
    totalMemMB: mem.totalMemMB,
    freeMemMB: mem.freeMemMB,
    uptimeHours: Math.round(os.uptime() / 3600),
    home: os.homedir(),
    shell: process.env.SHELL || null,
    termux: p.isTermux,
    android: p.isAndroid,
  };
  if (loadavg) info.loadavg = loadavg;

  try {
    const df = spawnSync("df", ["-h", os.homedir()], { encoding: "utf8", timeout: 5000 });
    const line = (df.stdout || "").trim().split("\n").pop() || "";
    const cols = line.split(/\s+/);
    if (cols.length >= 4) info.disk = { size: cols[1], used: cols[2], avail: cols[3], usePercent: cols[4] };
  } catch { }

  return info;
}

// Android 读不到 /proc/loadavg，用两次采样 /proc/stat 算 1 秒内的 CPU 使用率
export function cpuUsagePercent(sampleMs = 800) {
  const read = () => {
    const t = readFile("/proc/stat");
    const m = /^cpu\s+(.+)$/m.exec(t);
    if (!m) return null;
    const n = m[1].trim().split(/\s+/).map(Number);
    // user nice system idle iowait irq softirq steal
    const idle = (n[3] || 0) + (n[4] || 0);
    const total = n.reduce((a, b) => a + (b || 0), 0);
    return { idle, total };
  };
  return new Promise((resolve) => {
    const a = read();
    if (!a) return resolve(null);
    setTimeout(() => {
      const b = read();
      if (!b) return resolve(null);
      const dt = b.total - a.total;
      const di = b.idle - a.idle;
      if (dt <= 0) return resolve(null);
      resolve(Math.round(((dt - di) / dt) * 100));
    }, sampleMs);
  });
}
