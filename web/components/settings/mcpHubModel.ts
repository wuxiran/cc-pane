// MCP 页有效集的纯函数层：把启动档注入（内置 ccpanes + 共享服务）和本层 mcp.json 摊成一列卡片。
import { isSharedMcpServerSelected } from "@/components/providers/launchProfileHelpers";
import type { LaunchProfile, McpServerConfig } from "@/types";
import type { SharedMcpServerInfo, SharedMcpServerStatus } from "@/types/shared-mcp";

export type McpHubFilter = "all" | "profile" | "layer";

export type McpHubEntry =
  | { kind: "ccpanes"; name: string; enabled: boolean; canToggle: boolean }
  | { kind: "shared"; name: string; server: SharedMcpServerInfo; enabled: boolean; canToggle: boolean }
  | { kind: "layer"; name: string; config: McpServerConfig; layer: "workspace" | "project" };

export interface McpHubInput {
  profile: LaunchProfile | null;
  sharedServers: readonly SharedMcpServerInfo[];
  layerServers: Record<string, McpServerConfig>;
  layer: "workspace" | "project";
}

export function buildMcpHubEntries({ profile, sharedServers, layerServers, layer }: McpHubInput): McpHubEntry[] {
  const entries: McpHubEntry[] = [];
  const policy = profile?.mcpPolicy;
  const mcpOff = !policy || policy.mode === "disabled";

  if (profile && policy) {
    entries.push({
      kind: "ccpanes",
      name: "CC-Panes MCP",
      enabled: !mcpOff && policy.includeCcpanesMcp,
      canToggle: !mcpOff,
    });
    for (const server of sharedServers) {
      entries.push({
        kind: "shared",
        name: server.name,
        server,
        enabled: !mcpOff && isSharedMcpServerSelected(policy, server.name),
        canToggle: !mcpOff && policy.includeSharedMcp,
      });
    }
  }

  for (const [name, config] of Object.entries(layerServers).sort(([a], [b]) => a.localeCompare(b))) {
    entries.push({ kind: "layer", name, config, layer });
  }
  return entries;
}

export function filterMcpHubEntries(entries: readonly McpHubEntry[], filter: McpHubFilter): McpHubEntry[] {
  if (filter === "all") return [...entries];
  if (filter === "layer") return entries.filter((entry) => entry.kind === "layer");
  return entries.filter((entry) => entry.kind !== "layer");
}

/** 启动档实际会注入几个（开着的 ccpanes + 选中的共享） */
export function injectedCount(entries: readonly McpHubEntry[]): number {
  return entries.filter((entry) => entry.kind !== "layer" && entry.enabled).length;
}

export type SharedStatusKey = "running" | "stopped" | "starting" | "failed";

export function sharedStatusKey(status: SharedMcpServerStatus): SharedStatusKey {
  if (status === "running" || status === "starting" || status === "stopped") return status;
  return "failed";
}

export function commandLine(config: { command: string; args: readonly string[] }): string {
  return [config.command, ...config.args].join(" ").trim();
}
