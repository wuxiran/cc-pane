/**
 * MCP 配置状态管理（分层：工作空间层 / 项目覆盖层，docs/98）
 */
import { create } from "zustand";
import { mcpService } from "@/services";
import { mcpTargetKey, type McpLayerTarget, type McpServerConfig } from "@/types";
import { translateError } from "@/utils";

interface McpState {
  // ============ 状态 ============
  servers: Record<string, McpServerConfig>;
  /** 当前加载的层；`mcpTargetKey` 形式，用于判断写后是否需要刷新 */
  targetKey: string | null;
  /** 仅项目视图：旧 `.claude/settings.local.json` 里还没导入的条目 */
  legacyServers: Record<string, McpServerConfig>;
  loading: boolean;
  error: string | null;

  // ============ 操作 ============
  loadServers: (target: McpLayerTarget) => Promise<void>;
  upsertServer: (
    target: McpLayerTarget,
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>
  ) => Promise<void>;
  removeServer: (target: McpLayerTarget, name: string) => Promise<boolean>;
  loadLegacyServers: (projectPath: string) => Promise<void>;
  importLegacyServers: (projectPath: string, workspaceName?: string) => Promise<string[]>;
  clear: () => void;
}

export const useMcpStore = create<McpState>((set, get) => {
  const refreshIfCurrent = async (target: McpLayerTarget) => {
    if (get().targetKey !== mcpTargetKey(target)) return;
    const servers = await mcpService.listServers(target);
    set({ servers });
  };

  return {
    servers: {},
    targetKey: null,
    legacyServers: {},
    loading: false,
    error: null,

    loadServers: async (target) => {
      set({ loading: true, error: null, targetKey: mcpTargetKey(target) });
      try {
        const servers = await mcpService.listServers(target);
        set({ servers, loading: false });
      } catch (e) {
        set({ error: translateError(e), loading: false });
      }
    },

    upsertServer: async (target, name, command, args, env) => {
      await mcpService.upsertServer(target, name, command, args, env);
      await refreshIfCurrent(target);
    },

    removeServer: async (target, name) => {
      const removed = await mcpService.removeServer(target, name);
      if (removed) await refreshIfCurrent(target);
      return removed;
    },

    loadLegacyServers: async (projectPath) => {
      try {
        const legacyServers = await mcpService.listLegacyServers(projectPath);
        set({ legacyServers });
      } catch {
        set({ legacyServers: {} });
      }
    },

    importLegacyServers: async (projectPath, workspaceName) => {
      const imported = await mcpService.importLegacyServers(projectPath, workspaceName);
      if (imported.length > 0) {
        const target: McpLayerTarget = workspaceName ? { workspaceName } : { projectPath };
        await refreshIfCurrent(target);
      }
      return imported;
    },

    clear: () => set({ servers: {}, targetKey: null, legacyServers: {}, error: null }),
  };
});
