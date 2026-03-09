/**
 * MCP 配置状态管理
 */
import { create } from "zustand";
import { mcpService } from "@/services";
import type { McpServerConfig } from "@/types";
import { translateError } from "@/utils";

interface McpState {
  // ============ 状态 ============
  servers: Record<string, McpServerConfig>;
  projectPath: string | null;
  loading: boolean;
  error: string | null;

  // ============ 操作 ============
  loadServers: (projectPath: string) => Promise<void>;
  upsertServer: (
    projectPath: string,
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>
  ) => Promise<void>;
  removeServer: (projectPath: string, name: string) => Promise<boolean>;
  clear: () => void;
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: {},
  projectPath: null,
  loading: false,
  error: null,

  loadServers: async (projectPath) => {
    set({ loading: true, error: null, projectPath });
    try {
      const servers = await mcpService.listServers(projectPath);
      set({ servers, loading: false });
    } catch (e) {
      set({ error: translateError(e), loading: false });
    }
  },

  upsertServer: async (projectPath, name, command, args, env) => {
    await mcpService.upsertServer(projectPath, name, command, args, env);
    // 重新加载以保持同步
    const currentPath = get().projectPath;
    if (currentPath === projectPath) {
      const servers = await mcpService.listServers(projectPath);
      set({ servers });
    }
  },

  removeServer: async (projectPath, name) => {
    const removed = await mcpService.removeServer(projectPath, name);
    if (removed) {
      const currentPath = get().projectPath;
      if (currentPath === projectPath) {
        const servers = await mcpService.listServers(projectPath);
        set({ servers });
      }
    }
    return removed;
  },

  clear: () => set({ servers: {}, projectPath: null, error: null }),
}));
