import { apiGet, apiJson, invokeOrApi } from "./apiClient";
import type { AcceptTaskCompletionRequest, SetTaskCompletionCriteriaRequest, RunTaskVerificationRequest, TaskVerificationReport } from "@/types/taskVerification";

export const taskVerificationService = {
  list(taskId: string): Promise<TaskVerificationReport> {
    return invokeOrApi("list_task_verification", { taskId }, () =>
      apiGet(`/api/task-bindings/${encodeURIComponent(taskId)}/verification`),
    );
  },
  setCriteria(taskId: string, request: SetTaskCompletionCriteriaRequest): Promise<TaskVerificationReport> {
    return invokeOrApi("set_task_completion_criteria", { taskId, request }, () =>
      apiJson(`/api/task-bindings/${encodeURIComponent(taskId)}/completion/criteria`, "POST", request),
    );
  },
  accept(taskId: string, request: AcceptTaskCompletionRequest): Promise<TaskVerificationReport> {
    return invokeOrApi("accept_task_completion", { taskId, request }, () =>
      apiJson(`/api/task-bindings/${encodeURIComponent(taskId)}/completion/accept`, "POST", request),
    );
  },
  run(taskId: string, request: RunTaskVerificationRequest): Promise<TaskVerificationReport> {
    return invokeOrApi("run_task_verification", { taskId, request }, () =>
      apiJson(`/api/task-bindings/${encodeURIComponent(taskId)}/verification/run`, "POST", request),
    );
  },
};
