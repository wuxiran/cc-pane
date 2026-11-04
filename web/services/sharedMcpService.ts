import { apiDelete, apiGet, apiJson, apiNoContent, invokeOrApi } from "./apiClient";
import type {
  SharedMcpConfig,
  SharedMcpServerConfig,
  SharedMcpServerInfo,
} from "@/types";
import type { ClaudeUserMcpServer } from "@/types/shared-mcp";

export const sharedMcpService = {
  getConfig(): Promise<SharedMcpConfig> {
    return invokeOrApi<SharedMcpConfig>("get_shared_mcp_config", undefined, () =>
      apiGet<SharedMcpConfig>("/api/shared-mcp/config"),
    );
  },

  getStatus(): Promise<SharedMcpServerInfo[]> {
    return invokeOrApi<SharedMcpServerInfo[]>("get_shared_mcp_status", undefined, () =>
      apiGet<SharedMcpServerInfo[]>("/api/shared-mcp/status"),
    );
  },

  upsertServer(name: string, config: SharedMcpServerConfig): Promise<void> {
    return invokeOrApi<void>("upsert_shared_mcp_server", { name, config }, () =>
      apiJson<void>("/api/shared-mcp/servers", "PUT", { name, config }),
    );
  },

  removeServer(name: string): Promise<void> {
    return invokeOrApi<void>("remove_shared_mcp_server", { name }, () =>
      apiDelete(`/api/shared-mcp/servers/${encodeURIComponent(name)}`),
    );
  },

  startServer(name: string): Promise<void> {
    return invokeOrApi<void>("start_shared_mcp_server", { name }, () =>
      apiJson<void>(`/api/shared-mcp/servers/${encodeURIComponent(name)}/start`, "POST"),
    );
  },

  stopServer(name: string): Promise<void> {
    return invokeOrApi<void>("stop_shared_mcp_server", { name }, () =>
      apiJson<void>(`/api/shared-mcp/servers/${encodeURIComponent(name)}/stop`, "POST"),
    );
  },

  restartServer(name: string): Promise<void> {
    return invokeOrApi<void>("restart_shared_mcp_server", { name }, () =>
      apiJson<void>(`/api/shared-mcp/servers/${encodeURIComponent(name)}/restart`, "POST"),
    );
  },

  updateGlobalConfig(
    portRangeStart: number,
    portRangeEnd: number,
    healthCheckIntervalSecs: number,
    maxRestarts: number,
  ): Promise<void> {
    const body = {
      portRangeStart,
      portRangeEnd,
      healthCheckIntervalSecs,
      maxRestarts,
    };
    return invokeOrApi<void>("update_shared_mcp_global_config", body, () =>
      apiNoContent("/api/shared-mcp/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  listClaudeUserServers(): Promise<ClaudeUserMcpServer[]> {
    return invokeOrApi<ClaudeUserMcpServer[]>("list_claude_user_mcp_servers", undefined, () =>
      apiGet<ClaudeUserMcpServer[]>("/api/shared-mcp/claude-user-servers"),
    );
  },

  importFromClaude(): Promise<string[]> {
    return invokeOrApi<string[]>("import_shared_mcp_from_claude", undefined, () =>
      apiJson<string[]>("/api/shared-mcp/servers/import-from-claude", "POST"),
    );
  },
};
