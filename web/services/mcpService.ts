/**
 * MCP 配置管理服务层 — 封装所有 MCP 配置相关的 Tauri invoke 调用
 */
import type { McpLayerTarget, McpServerConfig, OrchestratorStatus } from "@/types";
import { invoke } from "@tauri-apps/api/core";
import { apiDeleteJson, apiGet, apiJson, invokeOrApi, isTauriRuntime } from "./apiClient";
import { listenWebviewIfTauri } from "./runtime";

const ORCHESTRATOR_STATUS_CHANGED_EVENT = "orchestrator-status-changed";

/** 层选择参数：只带有值的那一个，避免 `workspaceName: undefined` 进 query string。 */
function layerParams(target: McpLayerTarget): Record<string, string> {
  return target.workspaceName ? { workspaceName: target.workspaceName } : { projectPath: target.projectPath ?? "" };
}

function layerQuery(target: McpLayerTarget): string {
  return Object.entries(layerParams(target))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

export const mcpService = {
  /** 列出某一层（工作空间 / 项目覆盖层）的 MCP Server 配置 */
  async listServers(target: McpLayerTarget): Promise<Record<string, McpServerConfig>> {
    const params = layerParams(target);
    return invokeOrApi<Record<string, McpServerConfig>>("list_mcp_servers", params, () =>
      apiGet<Record<string, McpServerConfig>>("/api/mcp/servers", params),
    );
  },

  /** 获取单个 MCP Server 配置 */
  async getServer(target: McpLayerTarget, name: string): Promise<McpServerConfig | null> {
    const params = layerParams(target);
    return invokeOrApi<McpServerConfig | null>("get_mcp_server", { ...params, name }, () =>
      apiGet<McpServerConfig | null>(`/api/mcp/servers/${encodeURIComponent(name)}`, params),
    );
  },

  /** 添加或更新 MCP Server 配置 */
  async upsertServer(
    target: McpLayerTarget,
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>
  ): Promise<void> {
    const payload = { ...layerParams(target), name, command, args, env };
    return invokeOrApi<void>("upsert_mcp_server", payload, () =>
      apiJson<void>("/api/mcp/servers", "PUT", payload),
    );
  },

  /** 删除 MCP Server 配置 */
  async removeServer(target: McpLayerTarget, name: string): Promise<boolean> {
    return invokeOrApi<boolean>("remove_mcp_server", { ...layerParams(target), name }, () =>
      apiDeleteJson<boolean>(`/api/mcp/servers?${layerQuery(target)}&name=${encodeURIComponent(name)}`),
    );
  },

  /** 仍留在 `<repo>/.claude/settings.local.json` 里的旧项目级配置（只读） */
  async listLegacyServers(projectPath: string): Promise<Record<string, McpServerConfig>> {
    return invokeOrApi<Record<string, McpServerConfig>>("list_legacy_mcp_servers", { projectPath }, () =>
      apiGet<Record<string, McpServerConfig>>("/api/mcp/legacy-servers", { projectPath }),
    );
  },

  /** 把旧项目级配置导入到工作空间层（给 workspaceName）或项目覆盖层；返回导入的名字 */
  async importLegacyServers(projectPath: string, workspaceName?: string, overwrite = false): Promise<string[]> {
    const payload = workspaceName ? { projectPath, workspaceName, overwrite } : { projectPath, overwrite };
    return invokeOrApi<string[]>("import_legacy_mcp_servers", payload, () =>
      apiJson<string[]>("/api/mcp/legacy-servers/import", "POST", payload),
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

  async onOrchestratorStatusChanged(
    handler: (status: OrchestratorStatus) => void,
  ): Promise<() => void> {
    return listenWebviewIfTauri<OrchestratorStatus>(
      ORCHESTRATOR_STATUS_CHANGED_EVENT,
      (event) => handler(event.payload),
    );
  },
};
