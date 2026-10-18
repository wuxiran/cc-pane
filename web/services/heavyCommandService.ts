import type {
  HeavyCommandAggregate,
  HeavyCommandQuery,
  HeavyCommandRecord,
  HeavySamplerStats,
} from "@/types/heavyCommand";
import { invokeIfTauri } from "./runtime";

/** 重负载命令台账（docs/107 P2b）。Web runtime 下全部返回空。 */
export const heavyCommandService = {
  async list(query: HeavyCommandQuery = {}): Promise<HeavyCommandRecord[]> {
    return (await invokeIfTauri<HeavyCommandRecord[]>("list_heavy_commands", { query })) ?? [];
  },

  async aggregate(
    since: number | null,
    projectPath: string | null,
  ): Promise<HeavyCommandAggregate[]> {
    return (
      (await invokeIfTauri<HeavyCommandAggregate[]>("aggregate_heavy_commands", {
        since,
        projectPath,
      })) ?? []
    );
  },

  async clear(): Promise<number> {
    return (await invokeIfTauri<number>("clear_heavy_commands")) ?? 0;
  },

  async samplerStats(): Promise<HeavySamplerStats | null> {
    return (await invokeIfTauri<HeavySamplerStats>("get_heavy_sampler_stats")) ?? null;
  },
};
