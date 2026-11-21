// 配置读写：~/.config/termux-mcp-remote/config.json（权限 600）
// 首次运行时由 setup 向导生成。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "termux-mcp-remote");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const STATE_DIR = path.join(CONFIG_DIR, "state");
export const LOG_DIR = path.join(CONFIG_DIR, "logs");
export const PID_PATH = path.join(STATE_DIR, "agent.pid");
export const SUP_PID_PATH = path.join(STATE_DIR, "supervisor.pid");

export const DEFAULTS = {
  workerUrl: "",
  authToken: "",
  agentToken: "",
  name: "",
  deviceId: "",
  maxShells: 6,
  shellIdleMs: 30 * 60 * 1000,
};

export function ensureDirs() {
  for (const d of [CONFIG_DIR, STATE_DIR, LOG_DIR, path.join(STATE_DIR, "jobs")]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch { }
  const cfg = { ...DEFAULTS, ...saved };
  cfg.workerUrl = normalizeUrl(cfg.workerUrl);
  cfg.name = cfg.name || os.hostname() || "termux";
  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  const out = { ...DEFAULTS, ...cfg };
  out.workerUrl = normalizeUrl(out.workerUrl);
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { }
  return out;
}

export function normalizeUrl(u) {
  if (!u) return "";
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s.replace(/\/+$/, "");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function isConfigured(cfg) {
  return !!(cfg.workerUrl && cfg.authToken && cfg.agentToken);
}

export function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function writePid(pid) {
  ensureDirs();
  fs.writeFileSync(PID_PATH, String(pid), { mode: 0o600 });
}

export function clearPid() {
  try { fs.unlinkSync(PID_PATH); } catch { }
}
