// 读 CLI 注入描述的纯函数（docs/110 批 0）：规则镜像 cc-cli-adapters/src/injection_profile.rs，
// 前端所有 MCP / 技能 / 运行时门控都从这里走，不再各自维护 CLI 名单。
import type { InjectionProfile, NativeSkillSource } from "@/types/cliInjectionProfile";

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
