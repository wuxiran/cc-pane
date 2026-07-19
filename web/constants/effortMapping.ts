// effort → 后端行为映射常量（仅前端展示 / Args 预览用，真实注入在 Rust 侧）。
// 数值必须与 cc-cli-adapters/src/lib.rs 的 claude_max_thinking_tokens /
// codex_reasoning_effort 保持一致；launcherArgsPreview.test 与后端单测语义对拍。
import type { LaunchEffort } from "@/types";

/** Claude：effort 经 MAX_THINKING_TOKENS 环境变量注入思考预算（claude.rs build_command） */
export const CLAUDE_MAX_THINKING_TOKENS: Record<LaunchEffort, number> = {
  low: 4096,
  medium: 10000,
  high: 16000,
  xhigh: 31999,
  max: 63999,
};

/** Codex：`-c model_reasoning_effort=<v>`；codex 无 max 档，max 映射为 xhigh（codex.rs build_command） */
export const CODEX_REASONING_EFFORT: Record<LaunchEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/** chips 六档顺序：default（undefined，不注入）+ 显式五档 */
export const EFFORT_LEVELS: readonly LaunchEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
