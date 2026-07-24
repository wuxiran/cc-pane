import type { SystemStats } from "@/types";
import { invokeIfTauri } from "./runtime";

export const systemStatsService = {
  async get(): Promise<SystemStats | null> {
    return (await invokeIfTauri<SystemStats>("get_system_stats")) ?? null;
  },
};
