import { apiDelete, apiGet, invokeOrApi } from "./apiClient";

export interface PlanEntry {
  fileName: string;
  originalName: string;
  sessionId: string;
  archivedAt: string;
  size: number;
}

export const planService = {
  listPlans: (projectPath: string) =>
    invokeOrApi<PlanEntry[]>("list_plans", { projectPath }, () =>
      apiGet<PlanEntry[]>("/api/plans", { projectPath }),
    ),

  getPlanContent: (projectPath: string, fileName: string) =>
    invokeOrApi<string>("get_plan_content", { projectPath, fileName }, () =>
      apiGet<string>(`/api/plans/${encodeURIComponent(fileName)}`, { projectPath }),
    ),

  deletePlan: (projectPath: string, fileName: string) =>
    invokeOrApi<void>("delete_plan", { projectPath, fileName }, () =>
      apiDelete(`/api/plans/${encodeURIComponent(fileName)}?projectPath=${encodeURIComponent(projectPath)}`),
    ),
};
