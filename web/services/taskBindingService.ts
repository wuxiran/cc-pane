/**
 * TaskBinding 服务层 — 封装所有编排任务相关的 Tauri invoke 调用
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  TaskBinding,
  CreateTaskBindingRequest,
  UpdateTaskBindingRequest,
  TaskBindingQuery,
  TaskBindingQueryResult,
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

  /** 删除编排任务 */
  async delete(id: string): Promise<boolean> {
    return invoke<boolean>("delete_task_binding", { id });
  },

  /** 查询编排任务列表 */
  async query(query: TaskBindingQuery = {}): Promise<TaskBindingQueryResult> {
    return invoke<TaskBindingQueryResult>("query_task_bindings", { query });
  },
};
