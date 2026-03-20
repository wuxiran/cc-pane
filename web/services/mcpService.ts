/**
 * MCP 配置管理服务层 — 封装所有 MCP 配置相关的 Tauri invoke 调用
 */
import { invoke } from "@tauri-apps/api/core";
import type { McpServerConfig } from "@/types";

export const mcpService = {
  /** 列出项目的所有 MCP Server 配置 */
  async listServers(
    projectPath: string
  ): Promise<Record<string, McpServerConfig>> {
    return invoke<Record<string, McpServerConfig>>("list_mcp_servers", {
      projectPath,
    });
  },

  /** 获取单个 MCP Server 配置 */
  async getServer(
    projectPath: string,
    name: string
  ): Promise<McpServerConfig | null> {
    return invoke<McpServerConfig | null>("get_mcp_server", {
      projectPath,
      name,
    });
  },

  /** 添加或更新 MCP Server 配置 */
  async upsertServer(
    projectPath: string,
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>
  ): Promise<void> {
    return invoke("upsert_mcp_server", {
      projectPath,
      name,
      command,
      args,
      env,
    });
  },

  /** 删除 MCP Server 配置 */
  async removeServer(projectPath: string, name: string): Promise<boolean> {
    return invoke<boolean>("remove_mcp_server", { projectPath, name });
  },
};
