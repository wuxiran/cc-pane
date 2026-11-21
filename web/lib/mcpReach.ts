// 「这条 MCP 会送到哪些 CLI」（docs/110 批 5）：只读 CLI 注入描述（通道 / 传输方式 / 运行时），
// 规则与后端注入路径同口径——共享 MCP 远程条目走 `remoteMcpSupported`，本地 stdio 条目经 HTTP 桥
// （`stdioBridge`），工作空间 / 项目层看 `workspace`；WSL 只进 HTTP 型、SSH 什么都不进。
import type { InjectionProfile, InjectionProfileMap } from "@/types/cliInjectionProfile";
import { hasAnyMcp, remoteMcpSupported } from "./cliInjectionRules";

export type McpReachRuntime = "local" | "wsl" | "ssh";

export type McpReachSource =
  | { kind: "ccpanes" }
  | { kind: "shared"; remote: { transport: string; hasHeaders: boolean } | null }
  | { kind: "layer"; http: boolean };

function runtimeAllowsMcp(profile: InjectionProfile, runtime: McpReachRuntime): boolean {
  if (runtime === "local") return true;
  return profile.runtimes[runtime].mcp !== "none";
}

/** 这个 CLI 在这个运行时下能不能收到这条 MCP。 */
export function cliReceivesMcp(
  profile: InjectionProfile | null | undefined,
  source: McpReachSource,
  runtime: McpReachRuntime,
): boolean {
  if (!profile || !hasAnyMcp(profile) || !runtimeAllowsMcp(profile, runtime)) return false;
  const { mcp } = profile;
  switch (source.kind) {
    case "ccpanes":
      return mcp.ccpanes !== "none";
    case "shared":
      if (source.remote) return remoteMcpSupported(profile, source.remote.transport, source.remote.hasHeaders, runtime);
      return mcp.shared && mcp.transports.includes("stdioBridge");
    case "layer":
      // 工作空间层的 stdio 条目是宿主命令，进不了 WSL
      return mcp.workspace && (runtime === "local" || source.http);
  }
}

export interface McpReach {
  local: string[];
  wsl: string[];
  ssh: string[];
}

/** 按运行时列出能收到这条 MCP 的 CLI（按 id 排序）。 */
export function mcpReachByRuntime(profiles: InjectionProfileMap, source: McpReachSource): McpReach {
  const ids = Object.keys(profiles).sort();
  const pick = (runtime: McpReachRuntime) => ids.filter((id) => cliReceivesMcp(profiles[id], source, runtime));
  return { local: pick("local"), wsl: pick("wsl"), ssh: pick("ssh") };
}
