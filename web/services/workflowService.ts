/**
 * 多阶段工作流服务层（docs/114）。只在桌面端可用：Web 端列表恒空，入口随之隐藏。
 */
import { invokeOrApi } from "./apiClient";
import type { Workflow } from "@/types";

export const workflowService = {
  async list(activeOnly = false): Promise<Workflow[]> {
    return invokeOrApi<Workflow[]>("list_workflows", { activeOnly }, async () => []);
  },

  async approveStage(workflowId: string, stageIndex: number): Promise<Workflow> {
    return invokeOrApi<Workflow>("approve_workflow_stage", { workflowId, stageIndex }, async () => {
      throw new Error("Approve workflow stages in the desktop app");
    });
  },
};
