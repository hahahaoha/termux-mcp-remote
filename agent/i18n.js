// 文案查表：中文原文当 key，en 模式下查 messages.en.js。
//
// 用法：
//   t("Agent 未运行")
//   t("Agent 已启动（pid={0}）", pid)
//
// 占位符 {0} {1} … 在两种语言里位置可以不同，只要编号对应即可。
import { lang, saveLang, detectLang } from "./lang.js";
import EN from "./messages.en.js";

export { saveLang, detectLang, lang };

export function t(text, ...args) {
  let out = lang() === "zh" ? text : (EN[text] ?? text);
  if (args.length) {
    out = out.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));
  }
  return out;
}

// 是否英文模式（少数地方需要分支，比如拼接时语序不同）
export function isEn() {
  return lang() === "en";
}
