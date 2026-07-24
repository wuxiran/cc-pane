import type { KillProcessResult, ResourceTree, SystemStats } from "@/types";
import { invokeIfTauri } from "./runtime";

export const systemStatsService = {
  async get(): Promise<SystemStats | null> {
    return (await invokeIfTauri<SystemStats>("get_system_stats")) ?? null;
  },

  async getResourceTree(): Promise<ResourceTree | null> {
    return (await invokeIfTauri<ResourceTree>("get_resource_tree")) ?? null;
  },

  async killOrphans(pids: number[]): Promise<KillProcessResult[]> {
    return (await invokeIfTauri<KillProcessResult[]>("kill_orphan_processes", { pids })) ?? [];
  },
};
