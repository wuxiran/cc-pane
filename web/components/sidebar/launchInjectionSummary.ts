// 右键菜单里每个运行配置项旁的「会注入什么」摘要：MCP / Skill / 记忆 三个维度，
// 结合运行时（本机 / WSL / SSH）和 CLI 能力算出 on / partial / off。
import type { LaunchProfile } from "@/types";
import type { WorkspaceLaunchEnvironment } from "@/types/workspace";

export type InjectionState = "on" | "partial" | "off";

export interface InjectionSummary {
  mcp: InjectionState;
  skills: InjectionState;
  memory: InjectionState;
  /** 每个维度为什么是这个状态，给 tooltip 用（i18n key，不带 ns） */
  reasons: { mcp: string; skills: string; memory: string };
}

// docs/104：pi（扩展桥）/ omp（原生 .omp/mcp.json）/ jcode（原生
// .jcode/mcp.json，仅 stdio）已接入注入链，从名单移除。剩下的是 adapter
// 能力位 supports_mcp=false 的工具（与后端 capabilities 对齐）。
const MCP_UNSUPPORTED_CLIS = new Set(["gemini", "kimi"]);

export function summarizeInjection(
  profile: LaunchProfile | null,
  environment: WorkspaceLaunchEnvironment,
  cliTool: string,
): InjectionSummary {
  const mcpPolicy = profile?.mcpPolicy;
  const skillPolicy = profile?.skillPolicy;

  let mcp: InjectionState;
  let mcpReason: string;
  if (MCP_UNSUPPORTED_CLIS.has(cliTool)) {
    mcp = "off";
    mcpReason = "injection.mcpUnsupportedCli";
  } else if (mcpPolicy && (mcpPolicy.mode === "disabled" || !mcpPolicy.includeCcpanesMcp)) {
    mcp = "off";
    mcpReason = mcpPolicy.mode === "disabled" ? "injection.mcpDisabledByProfile" : "injection.mcpCcpanesOff";
  } else if (environment === "ssh") {
    mcp = "partial";
    mcpReason = "injection.mcpSshOnlyShared";
  } else if (environment === "wsl") {
    // WSL 拿到共享 MCP + 工作空间 / 项目层里的 HTTP 型；stdio 型是宿主命令，进不去
    mcp = "partial";
    mcpReason = "injection.mcpWslHttpOnly";
  } else {
    mcp = "on";
    mcpReason = "injection.mcpFull";
  }

  let skills: InjectionState;
  let skillsReason: string;
  if (skillPolicy && skillPolicy.mode === "disabled") {
    skills = "off";
    skillsReason = "injection.skillsDisabledByProfile";
  } else if (environment === "ssh") {
    skills = "off";
    skillsReason = "injection.skillsSshNone";
  } else if (skillPolicy && !skillPolicy.includeWorkspaceSkills) {
    skills = "partial";
    skillsReason = "injection.skillsWorkspaceOff";
  } else {
    skills = "on";
    skillsReason = environment === "wsl" ? "injection.skillsWslMounted" : "injection.skillsFull";
  }

  // 记忆召回走 SessionStart hook；skill 全关时 hook 不同步，召回可能就没了
  const memory: InjectionState = skills === "off" && environment !== "ssh" ? "partial" : skills === "off" ? "off" : "on";
  const memoryReason =
    skills === "off" && environment === "ssh"
      ? "injection.memorySshNone"
      : skills === "off"
        ? "injection.memoryHookMayBeMissing"
        : "injection.memoryFull";

  return {
    mcp,
    skills,
    memory,
    reasons: { mcp: mcpReason, skills: skillsReason, memory: memoryReason },
  };
}
