import { apiDelete, apiGet, invokeOrApi } from "./apiClient";

export interface PlanEntry {
  fileName: string;
  originalName: string;
  sessionId: string;
  archivedAt: string;
  size: number;
  /** 来源层（docs/98）：工作空间 / 项目本地缓存 / 旧的仓库内位置 */
  layer?: "workspace" | "project-cache" | "project-legacy";
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
