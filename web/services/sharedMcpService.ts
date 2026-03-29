import { invoke } from "@tauri-apps/api/core";
import type {
  SharedMcpConfig,
  SharedMcpServerConfig,
  SharedMcpServerInfo,
} from "@/types";

export const sharedMcpService = {
  getConfig(): Promise<SharedMcpConfig> {
    return invoke<SharedMcpConfig>("get_shared_mcp_config");
  },

  getStatus(): Promise<SharedMcpServerInfo[]> {
    return invoke<SharedMcpServerInfo[]>("get_shared_mcp_status");
  },

  upsertServer(name: string, config: SharedMcpServerConfig): Promise<void> {
    return invoke("upsert_shared_mcp_server", { name, config });
  },

  removeServer(name: string): Promise<void> {
    return invoke("remove_shared_mcp_server", { name });
  },

  startServer(name: string): Promise<void> {
    return invoke("start_shared_mcp_server", { name });
  },

  stopServer(name: string): Promise<void> {
    return invoke("stop_shared_mcp_server", { name });
  },

  restartServer(name: string): Promise<void> {
    return invoke("restart_shared_mcp_server", { name });
  },

  updateGlobalConfig(
    portRangeStart: number,
    portRangeEnd: number,
    healthCheckIntervalSecs: number,
    maxRestarts: number,
  ): Promise<void> {
    return invoke("update_shared_mcp_global_config", {
      portRangeStart,
      portRangeEnd,
      healthCheckIntervalSecs,
      maxRestarts,
    });
  },

  importFromClaude(): Promise<string[]> {
    return invoke<string[]>("import_shared_mcp_from_claude");
  },
};
