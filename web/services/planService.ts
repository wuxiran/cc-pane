import { invoke } from "@tauri-apps/api/core";

export interface PlanEntry {
  fileName: string;
  originalName: string;
  sessionId: string;
  archivedAt: string;
  size: number;
}

export const planService = {
  listPlans: (projectPath: string) =>
    invoke<PlanEntry[]>("list_plans", { projectPath }),

  getPlanContent: (projectPath: string, fileName: string) =>
    invoke<string>("get_plan_content", { projectPath, fileName }),

  deletePlan: (projectPath: string, fileName: string) =>
    invoke<void>("delete_plan", { projectPath, fileName }),
};
