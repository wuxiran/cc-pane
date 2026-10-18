/**
 * TaskBinding 服务层 — 封装所有编排任务相关的 Tauri invoke 调用
 */
import { apiDeleteJson, apiGet, apiJson, invokeOrApi } from "./apiClient";
import type {
  TaskBinding,
  CreateTaskBindingRequest,
  UpdateTaskBindingRequest,
  TaskBindingPatch,
  TaskBindingQuery,
  TaskBindingQueryResult,
  RegisterPlanLeaderRequest,
  RegisterPlanWorkerRequest,
  PlanCollaborationKey,
  PlanCollaboration,
} from "@/types";

export const taskBindingService = {
  /** Re-enter the desktop durable dispatcher; never silently launch with default settings. */
  async retryDispatched(bindingId: string): Promise<TaskBinding> {
    return invokeOrApi<TaskBinding>("retry_dispatched_task", { bindingId }, async () => {
      throw new Error("Retry this dispatched task in the desktop app");
    });
  },

  /** 创建编排任务 */
  async create(request: CreateTaskBindingRequest): Promise<TaskBinding> {
    return invokeOrApi<TaskBinding>("create_task_binding", { request }, () =>
      apiJson<TaskBinding>("/api/task-bindings", "POST", request),
    );
  },

  /** 获取单个编排任务 */
  async get(id: string): Promise<TaskBinding | null> {
    return invokeOrApi<TaskBinding | null>("get_task_binding", { id }, () =>
      apiGet<TaskBinding | null>(`/api/task-bindings/${encodeURIComponent(id)}`),
    );
  },

  /** 根据终端会话 ID 查找 */
  async findBySession(sessionId: string): Promise<TaskBinding | null> {
    return invokeOrApi<TaskBinding | null>("find_task_binding_by_session", { sessionId }, () =>
      apiGet<TaskBinding | null>("/api/task-bindings/by-session", { sessionId }),
    );
  },

  /** 更新编排任务 */
  async update(id: string, request: UpdateTaskBindingRequest): Promise<TaskBinding> {
    return invokeOrApi<TaskBinding>("update_task_binding", { id, request }, () =>
      apiJson<TaskBinding>(`/api/task-bindings/${encodeURIComponent(id)}`, "PATCH", request),
    );
  },

  /** Merge-patch 更新；metadata 会在 Rust 端深合并 */
  async updatePatch(id: string, patch: TaskBindingPatch): Promise<TaskBinding> {
    return invokeOrApi<TaskBinding>("update_task_binding_patch", { id, patch }, () =>
      apiJson<TaskBinding>(`/api/task-bindings/${encodeURIComponent(id)}/merge-patch`, "PATCH", patch),
    );
  },

  /** 删除编排任务 */
  async delete(id: string): Promise<boolean> {
    return invokeOrApi<boolean>("delete_task_binding", { id }, () =>
      apiDeleteJson<boolean>(`/api/task-bindings/${encodeURIComponent(id)}`),
    );
  },

  /** 原子级联删除编排任务 */
  async deleteCascade(id: string): Promise<boolean> {
    // fix(H3) review: leader 级联删除只发一次 Tauri command，由后端事务保证原子性。
    return invokeOrApi<boolean>("delete_task_binding_cascade", { id }, () =>
      apiDeleteJson<boolean>(`/api/task-bindings/${encodeURIComponent(id)}/cascade`),
    );
  },

  /** 查询编排任务列表 */
  async query(query: TaskBindingQuery = {}): Promise<TaskBindingQueryResult> {
    return invokeOrApi<TaskBindingQueryResult>("query_task_bindings", { query }, () =>
      apiJson<TaskBindingQueryResult>("/api/task-bindings/query", "POST", query),
    );
  },

  /** 登记 Plan-to-Codex leader */
  async registerPlanLeader(request: RegisterPlanLeaderRequest): Promise<TaskBinding> {
    return invokeOrApi<TaskBinding>("register_plan_leader", { request }, () =>
      apiJson<TaskBinding>("/api/plan-collaboration/leader", "POST", request),
    );
  },

  /** 登记 Plan-to-Codex worker */
  async registerPlanWorker(request: RegisterPlanWorkerRequest): Promise<TaskBinding> {
    return invokeOrApi<TaskBinding>("register_plan_worker", { request }, () =>
      apiJson<TaskBinding>("/api/plan-collaboration/worker", "POST", request),
    );
  },

  /** 查询 Plan 协作关系 */
  async getPlanCollaboration(
    key: PlanCollaborationKey,
    verbose = false
  ): Promise<PlanCollaboration> {
    return invokeOrApi<PlanCollaboration>("get_plan_collaboration", { key, verbose }, () =>
      apiGet<PlanCollaboration>("/api/plan-collaboration", { ...key, verbose }),
    );
  },

  /** 校准 Plan 协作关系的 live 状态 */
  async reconcilePlanCollaboration(
    key: PlanCollaborationKey,
    verbose = false
  ): Promise<PlanCollaboration> {
    return invokeOrApi<PlanCollaboration>("reconcile_plan_collaboration", { key, verbose }, () =>
      apiJson<PlanCollaboration>(
        `/api/plan-collaboration/reconcile?${new URLSearchParams(
          Object.entries({ ...key, verbose }).flatMap(([name, value]) =>
            value === undefined || value === null ? [] : [[name, String(value)]],
          ),
        ).toString()}`,
        "POST",
      ),
    );
  },
};
