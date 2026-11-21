// 右键菜单里每个运行配置项旁的「会注入什么」摘要：MCP / Skill / 记忆 三个维度，
// 结合运行时（本机 / WSL / SSH）和 CLI 能力算出 on / partial / off。
import type { LaunchProfile } from "@/types";
import type { WorkspaceLaunchEnvironment } from "@/types/workspace";
import { injectionProfileFor } from "@/services/cliInjectionProfileService";

export type InjectionState = "on" | "partial" | "off";

export interface InjectionSummary {
  mcp: InjectionState;
  skills: InjectionState;
  memory: InjectionState;
  /** 每个维度为什么是这个状态，给 tooltip 用（i18n key，不带 ns） */
  reasons: { mcp: string; skills: string; memory: string };
}

export function summarizeInjection(
  profile: LaunchProfile | null,
  environment: WorkspaceLaunchEnvironment,
  cliTool: string,
): InjectionSummary {
  const mcpPolicy = profile?.mcpPolicy;
  const skillPolicy = profile?.skillPolicy;

  // 门控读 adapter 注入描述（docs/110 批 0 单源），不再维护本地 CLI 名单。
  const cliProfile = injectionProfileFor(cliTool);
  const mcpChannels = cliProfile?.mcp;
  const hasMcp = !!mcpChannels && (mcpChannels.ccpanes !== "none" || mcpChannels.shared || mcpChannels.workspace);
  const wslMcp = cliProfile?.runtimes.wsl.mcp ?? "none";

  let mcp: InjectionState;
  let mcpReason: string;
  if (!hasMcp) {
    mcp = "off";
    mcpReason = "injection.mcpUnsupportedCli";
  } else if (mcpPolicy && mcpPolicy.mode === "disabled") {
    mcp = "off";
    mcpReason = "injection.mcpDisabledByProfile";
  } else if (environment === "ssh") {
    // SSH 远端命令只导出环境变量再跑裸 CLI（build_ssh_remote_command），任何 MCP 都带不过去。
    // 想要完整注入，要把那台机器添加为「设备」，由它本机的 CC-Panes 启动会话（docs/111）。
    mcp = "off";
    mcpReason = "injection.mcpSshNone";
  } else if (environment === "wsl") {
    // WSL 仍是旧语义：关掉 ccpanes 即全关（docs/110 批 4 再拆）
    if (wslMcp === "none" || (mcpPolicy && !mcpPolicy.includeCcpanesMcp)) {
      mcp = "off";
      mcpReason = wslMcp === "none" ? "injection.mcpWslNone" : "injection.mcpCcpanesOff";
    } else {
      mcp = wslMcp === "full" ? "on" : "partial";
      mcpReason = "injection.mcpWslHttpOnly";
    }
  } else if (mcpPolicy && !mcpPolicy.includeCcpanesMcp) {
    // 本机：只关 ccpanes 自身，共享与工作空间层照常注入（docs/110 批 0）
    const others = !!mcpChannels && (mcpChannels.shared || mcpChannels.workspace);
    mcp = others ? "partial" : "off";
    mcpReason = "injection.mcpCcpanesOff";
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
