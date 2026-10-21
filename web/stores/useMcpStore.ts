/** MCP configuration state is owned by its workspace/project layer (docs/98). */
import { create } from "zustand";
import { mcpService } from "@/services";
import { mcpTargetKey, type McpLayerTarget, type McpServerConfig } from "@/types";
import { translateError } from "@/utils";

export interface McpLayerState {
  servers: Record<string, McpServerConfig>;
  legacyServers: Record<string, McpServerConfig>;
  loading: boolean;
  error: string | null;
}

export const EMPTY_MCP_LAYER: McpLayerState = {
  servers: {}, legacyServers: {}, loading: false, error: null,
};

interface McpState {
  layers: Record<string, McpLayerState>;
  loadServers: (target: McpLayerTarget) => Promise<void>;
  upsertServer: (
    target: McpLayerTarget,
    name: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    descriptions?: Record<string, string>,
  ) => Promise<void>;
  removeServer: (target: McpLayerTarget, name: string) => Promise<boolean>;
  loadLegacyServers: (projectPath: string) => Promise<void>;
  importLegacyServers: (projectPath: string, workspaceName?: string) => Promise<string[]>;
  clear: () => void;
}

export const useMcpStore = create<McpState>((set) => {
  let sequence = 0;
  let epoch = 0;
  const serverRequests = new Map<string, number>();
  const legacyRequests = new Map<string, number>();

  const updateLayer = (key: string, patch: Partial<McpLayerState>) => set((state) => ({
    layers: { ...state.layers, [key]: { ...(state.layers[key] ?? EMPTY_MCP_LAYER), ...patch } },
  }));

  const loadServers = async (target: McpLayerTarget, propagateError = false) => {
    const key = mcpTargetKey(target);
    const request = ++sequence;
    serverRequests.set(key, request);
    updateLayer(key, { loading: true, error: null });
    try {
      const servers = await mcpService.listServers(target);
      if (serverRequests.get(key) === request) updateLayer(key, { servers, loading: false });
    } catch (error) {
      if (serverRequests.get(key) !== request) return;
      updateLayer(key, { error: translateError(error), loading: false });
      if (propagateError) throw error;
    }
  };

  const refreshAfterMutation = async (target: McpLayerTarget, startedIn: number) => {
    if (startedIn === epoch) await loadServers(target, true);
  };

  return {
    layers: {},
    loadServers,

    upsertServer: async (target, name, command, args, env, descriptions) => {
      const startedIn = epoch;
      await mcpService.upsertServer(target, name, command, args, env, descriptions);
      await refreshAfterMutation(target, startedIn);
    },

    removeServer: async (target, name) => {
      const startedIn = epoch;
      const removed = await mcpService.removeServer(target, name);
      if (removed) await refreshAfterMutation(target, startedIn);
      return removed;
    },

    loadLegacyServers: async (projectPath) => {
      const key = mcpTargetKey({ projectPath });
      const request = ++sequence;
      legacyRequests.set(key, request);
      try {
        const legacyServers = await mcpService.listLegacyServers(projectPath);
        if (legacyRequests.get(key) === request) updateLayer(key, { legacyServers });
      } catch {
        if (legacyRequests.get(key) === request) updateLayer(key, { legacyServers: {} });
      }
    },

    importLegacyServers: async (projectPath, workspaceName) => {
      const startedIn = epoch;
      const imported = await mcpService.importLegacyServers(projectPath, workspaceName);
      if (imported.length > 0) {
        const target: McpLayerTarget = workspaceName ? { workspaceName } : { projectPath };
        await refreshAfterMutation(target, startedIn);
      }
      return imported;
    },

    clear: () => {
      epoch += 1;
      serverRequests.clear();
      legacyRequests.clear();
      set({ layers: {} });
    },
  };
});
