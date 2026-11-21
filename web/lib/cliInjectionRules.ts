// 读 CLI 注入描述的纯函数（docs/110 批 0）：规则镜像 cc-cli-adapters/src/injection_profile.rs，
// 前端所有 MCP / 技能 / 运行时门控都从这里走，不再各自维护 CLI 名单。
import type { InjectionProfile, McpIsolation, NativeSkillSource } from "@/types/cliInjectionProfile";
import type { LaunchProfileMcpPolicy } from "@/types/launch-profile";

/** 这个 CLI 有没有任何一条 MCP 通道（ccpanes / 共享 / 工作空间层）。 */
export function hasAnyMcp(profile: InjectionProfile | null | undefined): boolean {
  if (!profile) return false;
  const { mcp } = profile;
  return mcp.ccpanes !== "none" || mcp.shared || mcp.workspace;
}

/**
 * 这条远程 MCP 能不能到达这个 CLI。与 `InjectionProfile::remote_mcp_supported` 一致：
 * WSL / SSH 走另一条注入路径，不带请求头也不走 SSE（批 4）。
 */
export function remoteMcpSupported(
  profile: InjectionProfile | null | undefined,
  transport: string,
  hasHeaders: boolean,
  runtime: string | null | undefined,
): boolean {
  if (!profile) return false;
  const wanted = transport === "sse" ? "sse" : "http";
  if (!profile.mcp.shared || !profile.mcp.transports.includes(wanted)) return false;
  if (runtime === "wsl" || runtime === "ssh") return !hasHeaders && wanted === "http";
  return !hasHeaders || profile.mcp.remoteHeaders;
}

/** 这个 CLI 自己会读的外部技能来源（启动档里的 Claude / Codex / Plugin 技能开关）。 */
export function nativeSkillSources(profile: InjectionProfile | null | undefined): NativeSkillSource[] {
  return profile?.skills.nativeSources ?? [];
}

/** 能否在 SSH 运行时启动。未知 CLI 按可启动处理（裸命令兜底）。 */
export function supportsSshLaunch(profile: InjectionProfile | null | undefined): boolean {
  return profile ? profile.runtimes.ssh.launch : true;
}

/** MCP 注入面的提示：只认 stdio、写项目文件、远程 MCP 带不了请求头。 */
export type McpProfileHint = "stdioOnly" | "projectFile" | "noRemoteHeaders";

export function mcpProfileHints(profile: InjectionProfile | null | undefined): McpProfileHint[] {
  if (!hasAnyMcp(profile) || !profile) return [];
  const hints: McpProfileHint[] = [];
  const { mcp } = profile;
  if (!mcp.transports.includes("http")) hints.push("stdioOnly");
  if (mcp.ccpanes === "projectFile" || mcp.ccpanes === "stdioProxy") hints.push("projectFile");
  if (mcp.shared && mcp.transports.includes("http") && !mcp.remoteHeaders) hints.push("noRemoteHeaders");
  return hints;
}

/**
 * 启动档是否要求「只用选中的 MCP」。与 terminal_service.rs `launch_profile_isolates_mcp` 同口径：
 * 自定义 / 全关一定隔离；默认模式下动过任何开关（禁用某个、追加某个、关掉 ccpanes 或共享层）也算。
 */
export function launchProfileIsolatesMcp(policy: LaunchProfileMcpPolicy | null | undefined): boolean {
  if (!policy) return false;
  if (policy.mode !== "default") return true;
  return (
    policy.enabledServerIds.length > 0 ||
    policy.disabledServerIds.length > 0 ||
    !policy.includeCcpanesMcp ||
    !policy.includeSharedMcp
  );
}

/**
 * 隔离要求下这个 CLI 实际做到哪一步（docs/110 批 3）：`full` = 用户自己配置的 server 也会被挡住；
 * 其余 = CLI 照样加载它自己配置里的 server，启动档只收窄 CC-Panes 注入的那部分。
 * 不要求隔离、或 CLI 根本没有 MCP 时返回 null（不提示）。
 */
export function mcpIsolationGap(
  profile: InjectionProfile | null | undefined,
  policy: LaunchProfileMcpPolicy | null | undefined,
): Exclude<McpIsolation, "full"> | null {
  if (!profile || !hasAnyMcp(profile) || !launchProfileIsolatesMcp(policy)) return null;
  const level = profile.mcp.isolation;
  return level === "full" ? null : level;
}

/** 启动档绑定到 WSL / SSH 时，这个 CLI 的 MCP 在该运行时能到哪一步（docs/110 批 4）。本机或完整时 null。 */
export type RuntimeMcpNote = "sshNone" | "wslNone" | "wslPartial";

export function runtimeMcpNote(
  profile: InjectionProfile | null | undefined,
  runtime: string | null | undefined,
): RuntimeMcpNote | null {
  if (!profile || !hasAnyMcp(profile)) return null;
  if (runtime === "ssh") return profile.runtimes.ssh.mcp === "full" ? null : "sshNone";
  if (runtime === "wsl") {
    const support = profile.runtimes.wsl.mcp;
    return support === "full" ? null : support === "none" ? "wslNone" : "wslPartial";
  }
  return null;
}
