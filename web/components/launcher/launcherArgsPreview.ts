// Args 预览纯函数：按 adapter 的 build_command 顺序拼近似命令行（仅展示，以后端为准）。
//
// 每个 CLI 一份声明式 spec，而不是一个手写函数——接第 N 个 CLI 时加的是数据不是分支。
// **顺序是 spec 的一部分**：三个 CLI 的 flag 次序互不相同（claude 的 effort 走 env 行、
// codex 的 effort 夹在中段、grok 的排在 --rules 之后），统一次序会拼错，故由 `order` 显式声明。
//
// 对拍关系（改这里必须同步核对后端）：
//   claude → cc-cli-adapters/src/claude.rs build_command
//   codex  → cc-cli-adapters/src/codex.rs  build_command（不消费 verbose/maxTurns）
//   grok   → cc-cli-adapters/src/grok.rs   build_command（不消费 verbose）
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

/** 一个可出现在命令行里的片段；`order` 用它们排出该 CLI 的真实次序。 */
type PreviewSegment =
  | "mcp"
  | "systemPrompt"
  | "yolo"
  | "effort"
  | "verbose"
  | "maxTurns"
  | "extraArgs"
  | "prompt";

interface CliPreviewSpec {
  command: string;
  /** 片段出现次序；未列出的片段 = 该 CLI 不消费该项。 */
  order: readonly PreviewSegment[];
  /** MCP 注入的展示形态：注入态与 skipMcp 态各一。 */
  mcp?: { enabled: readonly string[]; skipped?: readonly string[] };
  /** 系统提示词 flag；值会被引号包裹。 */
  systemPromptFlag?: string;
  /** `${flag}=${quoted}` 形态（codex 的 -c developer_instructions=...）。 */
  systemPromptStyle?: "separate" | "assign";
  yoloFlag?: string;
  /** effort 的注入形态：env 行 / 独立 flag / `-c key=value`。 */
  effort?:
    | { style: "env"; name: string; map: Record<string, number> }
    | { style: "flag"; flag: string; map?: Record<string, string> }
    | { style: "assign"; flag: string; key: string; map: Record<string, string> };
  verboseFlag?: string;
  maxTurnsFlag?: string;
  /** 位置参数直接跟在末尾；double-dash 先插一个 `--`。 */
  promptStyle?: "positional" | "double-dash";
}

const CLI_PREVIEW_SPECS: Partial<Record<CliTool, CliPreviewSpec>> = {
  claude: {
    command: "claude",
    order: ["mcp", "systemPrompt", "yolo", "verbose", "maxTurns", "extraArgs", "prompt"],
    mcp: { enabled: ["--mcp-config", "<auto>"] },
    systemPromptFlag: "--append-system-prompt",
    systemPromptStyle: "separate",
    yoloFlag: "--dangerously-skip-permissions",
    effort: { style: "env", name: "MAX_THINKING_TOKENS", map: CLAUDE_MAX_THINKING_TOKENS },
    verboseFlag: "--verbose",
    maxTurnsFlag: "--max-turns",
    promptStyle: "double-dash",
  },
  codex: {
    command: "codex",
    // codex 不消费 verbose/maxTurns；`-c` 必须排在 resume/positional 之前
    order: ["mcp", "systemPrompt", "effort", "yolo", "extraArgs", "prompt"],
    mcp: {
      enabled: ["-c", "mcp_servers.ccpanes=<auto>"],
      skipped: ["-c", "mcp_servers.ccpanes.enabled=false"],
    },
    systemPromptFlag: "-c developer_instructions",
    systemPromptStyle: "assign",
    yoloFlag: "--dangerously-bypass-approvals-and-sandbox",
    // codex 无 max 档，max 映射为 xhigh
    effort: {
      style: "assign",
      flag: "-c",
      key: "model_reasoning_effort",
      map: CODEX_REASONING_EFFORT,
    },
    promptStyle: "positional",
  },
  grok: {
    command: "grok",
    // grok 的 MCP 写用户级 config.toml，无 per-launch flag，故预览里没有 mcp 片段。
    // verbose 无对应 flag（--debug 是写日志，语义不同）。
    order: ["yolo", "systemPrompt", "effort", "maxTurns", "extraArgs", "prompt"],
    systemPromptFlag: "--rules",
    systemPromptStyle: "separate",
    yoloFlag: "--always-approve",
    // 取值枚举未知，按自由字符串透传档位名（与 grok.rs 同口径）
    effort: { style: "flag", flag: "--reasoning-effort" },
    maxTurnsFlag: "--max-turns",
    promptStyle: "positional",
  },
};

function quote(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const clipped =
    compact.length > PROMPT_PREVIEW_MAX ? `${compact.slice(0, PROMPT_PREVIEW_MAX)}…` : compact;
  return `"${clipped.replace(/"/g, '\\"')}"`;
}

/** 逐行返回预览（env 行 + 命令行）；none/未接入的 CLI 返回空数组（预览区隐藏） */
export function buildArgsPreview(input: ArgsPreviewInput): string[] {
  const spec = CLI_PREVIEW_SPECS[input.cliTool];
  if (!spec) return [];

  const lines: string[] = [];
  const args: string[] = [spec.command];
  const effort = input.adapterOptions?.effort;
  const systemPrompt = input.appendSystemPrompt?.trim();

  // env 行排在命令行之前，且不占 order 里的位置。
  if (effort && spec.effort?.style === "env") {
    lines.push(`${spec.effort.name}=${spec.effort.map[effort]}`);
  }

  for (const segment of spec.order) {
    switch (segment) {
      case "mcp": {
        const mcpArgs = input.skipMcp ? spec.mcp?.skipped : spec.mcp?.enabled;
        if (mcpArgs) args.push(...mcpArgs);
        break;
      }
      case "systemPrompt": {
        if (!systemPrompt || !spec.systemPromptFlag) break;
        if (spec.systemPromptStyle === "assign") {
          // "-c developer_instructions" → `-c` `developer_instructions="..."`
          const [flag, key] = spec.systemPromptFlag.split(" ");
          args.push(flag, `${key}=${quote(systemPrompt)}`);
        } else {
          args.push(spec.systemPromptFlag, quote(systemPrompt));
        }
        break;
      }
      case "yolo":
        if (input.yolo && spec.yoloFlag) args.push(spec.yoloFlag);
        break;
      case "effort": {
        if (!effort || !spec.effort) break;
        if (spec.effort.style === "assign") {
          args.push(spec.effort.flag, `${spec.effort.key}=${spec.effort.map[effort]}`);
        } else if (spec.effort.style === "flag") {
          args.push(spec.effort.flag, spec.effort.map?.[effort] ?? effort);
        }
        break;
      }
      case "verbose":
        if (input.adapterOptions?.verbose && spec.verboseFlag) args.push(spec.verboseFlag);
        break;
      case "maxTurns": {
        const maxTurns = input.adapterOptions?.maxTurns;
        if (maxTurns !== undefined && spec.maxTurnsFlag) {
          args.push(spec.maxTurnsFlag, String(maxTurns));
        }
        break;
      }
      case "extraArgs":
        args.push(...(input.adapterOptions?.extraArgs ?? []));
        break;
      case "prompt": {
        const prompt = input.initialPrompt?.trim();
        if (!prompt) break;
        if (spec.promptStyle === "double-dash") args.push("--");
        args.push(quote(prompt));
        break;
      }
    }
  }

  lines.push(args.join(" "));
  return lines;
}
