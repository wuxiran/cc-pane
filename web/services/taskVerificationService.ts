import { apiGet, apiJson, invokeOrApi } from "./apiClient";
import type { RunTaskVerificationRequest, TaskVerificationReport } from "@/types/taskVerification";

export const taskVerificationService = {
  list(taskId: string): Promise<TaskVerificationReport> {
    return invokeOrApi("list_task_verification", { taskId }, () =>
      apiGet(`/api/task-bindings/${encodeURIComponent(taskId)}/verification`),
    );
  },
  run(taskId: string, request: RunTaskVerificationRequest): Promise<TaskVerificationReport> {
    return invokeOrApi("run_task_verification", { taskId, request }, () =>
      apiJson(`/api/task-bindings/${encodeURIComponent(taskId)}/verification/run`, "POST", request),
    );
  },
};
