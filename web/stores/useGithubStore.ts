/**
 * gh CLI 可用性（安装 + 登录）。未就绪时 GitHub 相关入口直接隐藏，不弹横幅。
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { githubService, isGhReady } from "@/services/githubService";
import type { GhAvailability } from "@/types";
import { handleErrorSilent } from "@/utils/errorHandler";

interface GithubState {
  availability: GhAvailability | null;
  loading: boolean;
  /** 读取可用性；refresh=true 时强制重新探测 */
  load: (refresh?: boolean) => Promise<void>;
}

let inflight: Promise<void> | null = null;

export const useGithubStore = create<GithubState>()(
  immer((set) => ({
    availability: null,
    loading: false,
    load: (refresh = false) => {
      if (inflight && !refresh) return inflight;
      set((state) => {
        state.loading = true;
      });
      const task = githubService
        .status(refresh)
        .then((availability) => {
          set((state) => {
            state.availability = availability;
          });
        })
        .catch((error: unknown) => handleErrorSilent(error, "github cli status"))
        .finally(() => {
          set((state) => {
            state.loading = false;
          });
          if (inflight === task) inflight = null;
        });
      inflight = task;
      return task;
    },
  })),
);

/** gh 是否可用（已安装且已登录） */
export function selectGhReady(state: GithubState): boolean {
  return isGhReady(state.availability);
}
