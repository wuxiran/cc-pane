import type {
  KillProcessResult,
  ResourcePolicyStatus,
  ResourceTree,
  SessionResourcePolicy,
  SystemStats,
} from "@/types";
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

  /** 对运行中的会话重新下发资源策略（正常 / 让路 / 效率模式）。 */
  async setSessionResourcePolicy(
    sessionId: string,
    policy: SessionResourcePolicy,
  ): Promise<ResourcePolicyStatus | null> {
    return (
      (await invokeIfTauri<ResourcePolicyStatus>("set_session_resource_policy", {
        sessionId,
        policy,
      })) ?? null
    );
  },
};
