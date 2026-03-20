/** MCP Server 配置项 */
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}
