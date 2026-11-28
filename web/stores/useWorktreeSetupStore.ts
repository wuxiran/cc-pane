import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { WorktreeSetupPlan } from "@/services/worktreeService";

/** 等待用户确认的 worktree setup（一次只弹一个，按创建顺序排队）。 */
interface WorktreeSetupState {
  queue: WorktreeSetupPlan[];
  enqueue(plan: WorktreeSetupPlan): void;
  /** 关掉队首（无论执行与否） */
  shift(): void;
}

export const useWorktreeSetupStore = create<WorktreeSetupState>()(
  immer((set) => ({
    queue: [],
    enqueue: (plan) =>
      set((state) => {
        if (state.queue.some((item) => item.worktreePath === plan.worktreePath)) return;
        state.queue.push(plan);
      }),
    shift: () =>
      set((state) => {
        state.queue.shift();
      }),
  })),
);
