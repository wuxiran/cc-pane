/**
 * MCP 配置管理服务层 — 封装所有 MCP 配置相关的 Tauri invoke 调用
 */
import type { McpServerConfig, OrchestratorStatus } from "@/types";
import { invoke } from "@tauri-apps/api/core";
import { apiDeleteJson, apiGet, apiJson, invokeOrApi, isTauriRuntime } from "./apiClient";

export const mcpService = {
  /** 列出项目的所有 MCP Server 配置 */
  async listServers(
    projectPath: string
  ): Promise<Record<string, McpServerConfig>> {
    return invokeOrApi<Record<string, McpServerConfig>>("list_mcp_servers", { projectPath }, () =>
      apiGet<Record<string, McpServerConfig>>("/api/mcp/servers", { projectPath }),
    );
  },

  /** 获取单个 MCP Server 配置 */
  async getServer(
    projectPath: string,
    name: string
  ): Promise<McpServerConfig | null> {
    return invokeOrApi<McpServerConfig | null>("get_mcp_server", { projectPath, name }, () =>
      apiGet<McpServerConfig | null>(`/api/mcp/servers/${encodeURIComponent(name)}`, { projectPath }),
    );
  },

  /** 添加或更新 MCP Server 配置 */
  async upsertServer(
    projectPath: string,
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>
  ): Promise<void> {
    return invokeOrApi<void>("upsert_mcp_server", { projectPath, name, command, args, env }, () =>
      apiJson<void>("/api/mcp/servers", "PUT", { projectPath, name, command, args, env }),
    );
  },

  /** 删除 MCP Server 配置 */
  async removeServer(projectPath: string, name: string): Promise<boolean> {
    return invokeOrApi<boolean>("remove_mcp_server", { projectPath, name }, () =>
      apiDeleteJson<boolean>(`/api/mcp/servers?projectPath=${encodeURIComponent(projectPath)}&name=${encodeURIComponent(name)}`),
    );
  },

  /** 获取 CC-Panes 自身 MCP Orchestrator 的连接信息（port + token） */
  async getOrchestratorInfo(): Promise<{ port: number | null; token: string }> {
    if (!isTauriRuntime()) return { port: null, token: "" };
    const [port, token] = await Promise.all([
      invoke<number | null>("get_orchestrator_port"),
      invoke<string>("get_orchestrator_token"),
    ]);
    return { port, token };
  },

  /** 获取 Orchestrator 运行状态（端口 + 绑定决策，设置页展示用） */
  async getOrchestratorStatus(): Promise<OrchestratorStatus | null> {
    if (!isTauriRuntime()) return null;
    return invoke<OrchestratorStatus>("get_orchestrator_status");
  },
};
