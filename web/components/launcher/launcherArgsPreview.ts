// Args 预览纯函数：按 adapter 的 build_command 顺序拼近似命令行（仅展示，以后端为准）。
// claude 对齐 cc-cli-adapters/src/claude.rs build_command：
//   --mcp-config → --append-system-prompt → yolo → --verbose → --max-turns → extraArgs → `--` prompt，
//   effort 不是 flag，显示为 `MAX_THINKING_TOKENS=<n>` env 行前缀。
// codex 对齐 cc-cli-adapters/src/codex.rs build_command：
//   -c mcp override → -c developer_instructions → -c model_reasoning_effort（在 resume/positional 之前）
//   → yolo → extraArgs → prompt；codex 不消费 verbose/maxTurns。
import type { CliTool, LaunchAdapterOptions } from "@/types";
import {
  CLAUDE_MAX_THINKING_TOKENS,
  CODEX_REASONING_EFFORT,
} from "@/constants/effortMapping";

export interface ArgsPreviewInput {
  cliTool: CliTool;
  skipMcp?: boolean;
  appendSystemPrompt?: string;
  initialPrompt?: string;
  /** undefined = 跟随 profile（预览不显示）；true = 显式 YOLO flag */
  yolo?: boolean;
  adapterOptions?: LaunchAdapterOptions;
}

const PROMPT_PREVIEW_MAX = 60;

function quote(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const clipped =
    compact.length > PROMPT_PREVIEW_MAX ? `${compact.slice(0, PROMPT_PREVIEW_MAX)}…` : compact;
  return `"${clipped.replace(/"/g, '\\"')}"`;
}

/** 逐行返回预览（env 行 + 命令行）；none/未知 CLI 返回空数组（预览区隐藏） */
export function buildArgsPreview(input: ArgsPreviewInput): string[] {
  if (input.cliTool === "claude") return buildClaudePreview(input);
  if (input.cliTool === "codex") return buildCodexPreview(input);
  return [];
}

function buildClaudePreview(input: ArgsPreviewInput): string[] {
  const lines: string[] = [];
  const effort = input.adapterOptions?.effort;
  if (effort) {
    lines.push(`MAX_THINKING_TOKENS=${CLAUDE_MAX_THINKING_TOKENS[effort]}`);
  }

  const args: string[] = ["claude"];
  if (!input.skipMcp) {
    args.push("--mcp-config", "<auto>");
  }
  if (input.appendSystemPrompt?.trim()) {
    args.push("--append-system-prompt", quote(input.appendSystemPrompt));
  }
  if (input.yolo) {
    args.push("--dangerously-skip-permissions");
  }
  if (input.adapterOptions?.verbose) {
    args.push("--verbose");
  }
  if (input.adapterOptions?.maxTurns !== undefined) {
    args.push("--max-turns", String(input.adapterOptions.maxTurns));
  }
  args.push(...(input.adapterOptions?.extraArgs ?? []));
  if (input.initialPrompt?.trim()) {
    args.push("--", quote(input.initialPrompt));
  }
  lines.push(args.join(" "));
  return lines;
}

function buildCodexPreview(input: ArgsPreviewInput): string[] {
  const args: string[] = ["codex"];
  if (input.skipMcp) {
    args.push("-c", "mcp_servers.ccpanes.enabled=false");
  } else {
    args.push("-c", "mcp_servers.ccpanes=<auto>");
  }
  if (input.appendSystemPrompt?.trim()) {
    args.push("-c", `developer_instructions=${quote(input.appendSystemPrompt)}`);
  }
  const effort = input.adapterOptions?.effort;
  if (effort) {
    // codex 无 max 档：max 映射为 xhigh；`-c` 必须在 resume/positional 之前
    args.push("-c", `model_reasoning_effort=${CODEX_REASONING_EFFORT[effort]}`);
  }
  if (input.yolo) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  args.push(...(input.adapterOptions?.extraArgs ?? []));
  if (input.initialPrompt?.trim()) {
    args.push(quote(input.initialPrompt));
  }
  return [args.join(" ")];
}
