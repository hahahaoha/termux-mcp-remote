// 语言选择：让 tmcp 命令的输出跟随安装时选的语言。
//
// 优先级（从高到低）：
//   1. 环境变量 TMCP_LANG=en|zh      —— 临时切换
//   2. config.json 里的 lang 字段     —— `tmcp lang en` 写进去的
//   3. ~/.config/termux-mcp-remote/lang —— 安装脚本写的（此时还没 config.json）
//   4. 系统 locale（zh* → 中文）
//   5. 兜底英文
//
// 安装脚本分工：get.sh 写 en，get-zh.sh 写 zh，install.sh 跟随 $LANG。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "termux-mcp-remote");
const LANG_FILE = path.join(CONFIG_DIR, "lang");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const NORMAL = { en: "en", zh: "zh", chinese: "zh", english: "en", cn: "zh" };

function norm(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  if (NORMAL[s]) return NORMAL[s];
  if (s.startsWith("zh")) return "zh";
  if (s.startsWith("en")) return "en";
  return "";
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

export function detectLang() {
  const fromEnv = norm(process.env.TMCP_LANG);
  if (fromEnv) return fromEnv;

  try {
    const cfg = JSON.parse(readFileSafe(CONFIG_PATH) || "{}");
    const fromCfg = norm(cfg.lang);
    if (fromCfg) return fromCfg;
  } catch { /* 配置坏了就往下走 */ }

  const fromFile = norm(readFileSafe(LANG_FILE));
  if (fromFile) return fromFile;

  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const fromLocale = norm(locale);
  if (fromLocale) return fromLocale;

  return "en";
}

let cached = null;
export function lang() {
  if (!cached) cached = detectLang();
  return cached;
}

// 写入语言偏好（安装脚本与 `tmcp lang` 共用）
export function saveLang(l) {
  const v = norm(l);
  if (!v) throw new Error("unknown language: " + l);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(LANG_FILE, v + "\n", { mode: 0o600 });
  try {
    const raw = readFileSafe(CONFIG_PATH);
    if (raw) {
      const cfg = JSON.parse(raw);
      cfg.lang = v;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    }
  } catch { /* 忽略 */ }
  cached = v;
  return v;
}
