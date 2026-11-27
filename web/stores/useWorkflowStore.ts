import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { workflowService } from "@/services/workflowService";
import type { Workflow } from "@/types";

interface WorkflowState {
  /** 按父 TaskBinding id 索引。 */
  byId: Record<string, Workflow>;
  approving: Record<string, boolean>;
  error: string | null;
  load: () => Promise<void>;
  approve: (workflowId: string, stageIndex: number) => Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const useWorkflowStore = create<WorkflowState>()(
  immer((set) => ({
    byId: {},
    approving: {},
    error: null,

    load: () => {
      // 复用进行中的请求：事件风暴时只打一次后端。
      if (inFlight) return inFlight;
      inFlight = workflowService
        .list(false)
        .then((workflows) => {
          set((state) => {
            state.byId = Object.fromEntries(workflows.map((workflow) => [workflow.id, workflow]));
            state.error = null;
          });
        })
        .catch((error: unknown) => {
          console.warn("[workflow] list failed", error);
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    approve: async (workflowId, stageIndex) => {
      const key = `${workflowId}:${stageIndex}`;
      set((state) => {
        state.approving[key] = true;
        state.error = null;
      });
      try {
        const workflow = await workflowService.approveStage(workflowId, stageIndex);
        set((state) => {
          state.byId[workflow.id] = workflow;
        });
      } catch (error) {
        set((state) => {
          state.error = error instanceof Error ? error.message : String(error);
        });
      } finally {
        set((state) => {
          delete state.approving[key];
        });
      }
    },
  })),
);
