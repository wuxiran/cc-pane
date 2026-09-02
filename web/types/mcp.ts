/** MCP Server 配置项（stdio 字段；HTTP 条目会带 `url` / `type`，由后端透传保留） */
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * 分层 MCP 配置的目标层（docs/98 workspace-first）：
 * 给 `workspaceName` 走 `~/.cc-panes/workspaces/<name>/mcp.json`，
 * 否则 `projectPath` 走 `<repo>/.ccpanes/mcp.json`。
 */
export type McpLayerTarget = { workspaceName: string; projectPath?: undefined } | { projectPath: string; workspaceName?: undefined };

export function mcpTargetKey(target: McpLayerTarget): string {
  return target.workspaceName ? `workspace:${target.workspaceName}` : `project:${target.projectPath}`;
}
