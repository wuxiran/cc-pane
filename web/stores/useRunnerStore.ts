/**
 * Runner Registry Zustand store
 *
 * 管理：每个项目的 RunnerProfile 列表 + 全局活跃 RunnerInstance 列表 + port_claims 缓存。
 * Profile 按项目路径分桶；活跃实例跨项目共享一个 list（用户能在 StatusBar 看到 N 个运行中）。
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { runnerService } from "@/services/runnerService";
import type {
  PortClaim,
  PortConflict,
  RunnerInstance,
  RunnerLaunchPlan,
  RunnerProfile,
  RunnerProfileDraft,
} from "@/types/runner";

interface RunnerState {
  /** 按 projectPath 分桶的 profile 列表 */
  profilesByProject: Record<string, RunnerProfile[]>;
  /** 全局活跃 instance（跨项目） */
  activeInstances: RunnerInstance[];
  /** instance_id -> port claims */
  portClaimsByInstance: Record<string, PortClaim[]>;
  loading: Record<string, boolean>;

  loadProfiles: (projectPath: string) => Promise<void>;
  upsertProfile: (draft: RunnerProfileDraft) => Promise<RunnerProfile>;
  deleteProfile: (id: string, projectPath: string) => Promise<void>;

  planLaunch: (profileId: string) => Promise<RunnerLaunchPlan>;
  listPortConflicts: (ports: number[]) => Promise<PortConflict[]>;

  loadActiveInstances: (projectPath?: string) => Promise<void>;
  refreshPortClaims: (instanceId: string) => Promise<void>;
  killInstance: (instanceId: string) => Promise<boolean>;
  killPid: (pid: number) => Promise<boolean>;
}

export const useRunnerStore = create<RunnerState>()(
  immer((set) => ({
    profilesByProject: {},
    activeInstances: [],
    portClaimsByInstance: {},
    loading: {},

    loadProfiles: async (projectPath) => {
      const key = `profiles:${projectPath}`;
      set((s) => {
        s.loading[key] = true;
      });
      try {
        const profiles = await runnerService.listProfiles(projectPath);
        set((s) => {
          s.profilesByProject[projectPath] = profiles;
        });
      } finally {
        set((s) => {
          delete s.loading[key];
        });
      }
    },

    upsertProfile: async (draft) => {
      const profile = await runnerService.upsertProfile(draft);
      set((s) => {
        const bucket = s.profilesByProject[profile.projectPath] ?? [];
        const idx = bucket.findIndex((p) => p.id === profile.id);
        if (idx >= 0) bucket[idx] = profile;
        else bucket.unshift(profile);
        s.profilesByProject[profile.projectPath] = bucket;
      });
      return profile;
    },

    deleteProfile: async (id, projectPath) => {
      await runnerService.deleteProfile(id);
      set((s) => {
        const bucket = s.profilesByProject[projectPath];
        if (bucket) {
          s.profilesByProject[projectPath] = bucket.filter((p) => p.id !== id);
        }
      });
    },

    planLaunch: async (profileId) => {
      return runnerService.planLaunch(profileId);
    },

    listPortConflicts: async (ports) => {
      return runnerService.listPortConflicts(ports);
    },

    loadActiveInstances: async (projectPath) => {
      const instances = await runnerService.listActiveInstances(projectPath);
      set((s) => {
        if (projectPath) {
          // 替换该项目的实例；保留其他项目的
          const others = s.activeInstances.filter(
            (i) => i.projectPath !== projectPath,
          );
          s.activeInstances = [...others, ...instances];
        } else {
          s.activeInstances = instances;
        }
      });
    },

    refreshPortClaims: async (instanceId) => {
      const claims = await runnerService.refreshPortClaims(instanceId);
      set((s) => {
        s.portClaimsByInstance[instanceId] = claims;
      });
    },

    killInstance: async (instanceId) => {
      const killed = await runnerService.killInstance(instanceId);
      if (killed) {
        set((s) => {
          s.activeInstances = s.activeInstances.filter(
            (i) => i.id !== instanceId,
          );
          delete s.portClaimsByInstance[instanceId];
        });
      }
      return killed;
    },

    killPid: async (pid) => {
      return runnerService.killPid(pid);
    },
  })),
);
