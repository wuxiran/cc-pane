// MCP 页的纯函数层：把内置、共享、工作空间和项目的 MCP 摊成一张表。
import { commandLine } from "@/components/settings/mcpCommandLine";
import type { McpLayerTarget, McpServerConfig, SharedMcpServerInfo } from "@/types";

export type McpLayerKind = "workspace" | "project";

export type McpLibraryEntry =
  | { key: "ccpanes"; kind: "ccpanes"; name: string }
  | { key: string; kind: "shared"; name: string; server: SharedMcpServerInfo }
  | {
      key: string;
      kind: "layer";
      name: string;
      layer: McpLayerKind;
      target: McpLayerTarget;
      config: McpServerConfig;
      /** 同名时项目覆盖工作空间，这一条实际不会生效 */
      shadowed: boolean;
    };

export interface McpLibraryInput {
  sharedServers: readonly SharedMcpServerInfo[];
  workspace?: { target: McpLayerTarget; servers: Record<string, McpServerConfig> } | null;
  project?: { target: McpLayerTarget; servers: Record<string, McpServerConfig> } | null;
}

function sortedNames(servers: Record<string, McpServerConfig>): string[] {
  return Object.keys(servers).sort((a, b) => a.localeCompare(b));
}

export function buildMcpLibraryEntries({ sharedServers, workspace, project }: McpLibraryInput): McpLibraryEntry[] {
  const entries: McpLibraryEntry[] = [{ key: "ccpanes", kind: "ccpanes", name: "CC-Panes MCP" }];
  for (const server of [...sharedServers].sort((a, b) => a.name.localeCompare(b.name))) {
    entries.push({ key: `shared:${server.name}`, kind: "shared", name: server.name, server });
  }
  if (project) {
    for (const name of sortedNames(project.servers)) {
      entries.push({ key: `project:${name}`, kind: "layer", name, layer: "project", target: project.target, config: project.servers[name], shadowed: false });
    }
  }
  if (workspace) {
    for (const name of sortedNames(workspace.servers)) {
      entries.push({
        key: `workspace:${name}`,
        kind: "layer",
        name,
        layer: "workspace",
        target: workspace.target,
        config: workspace.servers[name],
        shadowed: Boolean(project && name in project.servers),
      });
    }
  }
  return entries;
}

/** 这条资源实际执行什么，用于列表副标题和搜索。 */
export function entryDetail(entry: McpLibraryEntry): string {
  switch (entry.kind) {
    case "ccpanes":
      return "";
    case "shared":
      return entry.server.config.remote?.url ?? commandLine(entry.server.config);
    case "layer":
      return entry.config.url ?? commandLine(entry.config);
  }
}

export function filterMcpLibraryEntries(entries: readonly McpLibraryEntry[], query: string): McpLibraryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) => `${entry.name} ${entryDetail(entry)}`.toLowerCase().includes(needle));
}
