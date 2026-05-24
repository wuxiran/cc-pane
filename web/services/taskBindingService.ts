/**
 * TaskBinding 服务层 — 封装所有编排任务相关的 Tauri invoke 调用
 */
import { invoke } from "@tauri-apps/api/core";
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
  /** 创建编排任务 */
  async create(request: CreateTaskBindingRequest): Promise<TaskBinding> {
    return invoke<TaskBinding>("create_task_binding", { request });
  },

  /** 获取单个编排任务 */
  async get(id: string): Promise<TaskBinding | null> {
    return invoke<TaskBinding | null>("get_task_binding", { id });
  },

  /** 根据终端会话 ID 查找 */
  async findBySession(sessionId: string): Promise<TaskBinding | null> {
    return invoke<TaskBinding | null>("find_task_binding_by_session", { sessionId });
  },

  /** 更新编排任务 */
  async update(id: string, request: UpdateTaskBindingRequest): Promise<TaskBinding> {
    return invoke<TaskBinding>("update_task_binding", { id, request });
  },

  /** Merge-patch 更新；metadata 会在 Rust 端深合并 */
  async updatePatch(id: string, patch: TaskBindingPatch): Promise<TaskBinding> {
    return invoke<TaskBinding>("update_task_binding_patch", { id, patch });
  },

  /** 删除编排任务 */
  async delete(id: string): Promise<boolean> {
    return invoke<boolean>("delete_task_binding", { id });
  },

  /** 原子级联删除编排任务 */
  async deleteCascade(id: string): Promise<boolean> {
    // fix(H3) review: leader 级联删除只发一次 Tauri command，由后端事务保证原子性。
    return invoke<boolean>("delete_task_binding_cascade", { id });
  },

  /** 查询编排任务列表 */
  async query(query: TaskBindingQuery = {}): Promise<TaskBindingQueryResult> {
    return invoke<TaskBindingQueryResult>("query_task_bindings", { query });
  },

  /** 登记 Plan-to-Codex leader */
  async registerPlanLeader(request: RegisterPlanLeaderRequest): Promise<TaskBinding> {
    return invoke<TaskBinding>("register_plan_leader", { request });
  },

  /** 登记 Plan-to-Codex worker */
  async registerPlanWorker(request: RegisterPlanWorkerRequest): Promise<TaskBinding> {
    return invoke<TaskBinding>("register_plan_worker", { request });
  },

  /** 查询 Plan 协作关系 */
  async getPlanCollaboration(
    key: PlanCollaborationKey,
    verbose = false
  ): Promise<PlanCollaboration> {
    return invoke<PlanCollaboration>("get_plan_collaboration", { key, verbose });
  },

  /** 校准 Plan 协作关系的 live 状态 */
  async reconcilePlanCollaboration(
    key: PlanCollaborationKey,
    verbose = false
  ): Promise<PlanCollaboration> {
    return invoke<PlanCollaboration>("reconcile_plan_collaboration", { key, verbose });
  },
};
