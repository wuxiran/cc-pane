/**
 * Todo 服务层 — 封装所有 Todo 相关的 Tauri invoke 调用
 */
import { apiDelete, apiGet, apiJson, invokeOrApi } from "./apiClient";
import type {
  TodoItem,
  TodoActivity,
  TodoSubtask,
  TodoStatus,
  TodoScope,
  CreateTodoRequest,
  UpdateTodoRequest,
  TodoQuery,
  TodoQueryResult,
  TodoStats,
} from "@/types";

export const todoService = {
  // ============ TodoItem (8 个) ============

  /** 创建 Todo */
  async create(request: CreateTodoRequest): Promise<TodoItem> {
    return invokeOrApi<TodoItem>("create_todo", { request }, () =>
      apiJson<TodoItem>("/api/todos", "POST", request),
    );
  },

  /** 获取单个 Todo */
  async get(id: string): Promise<TodoItem | null> {
    return invokeOrApi<TodoItem | null>("get_todo", { id }, () =>
      apiGet<TodoItem | null>(`/api/todos/${encodeURIComponent(id)}`),
    );
  },

  /** 更新 Todo */
  async update(id: string, request: UpdateTodoRequest): Promise<TodoItem> {
    return invokeOrApi<TodoItem>("update_todo", { id, request }, () =>
      apiJson<TodoItem>(`/api/todos/${encodeURIComponent(id)}`, "PATCH", request),
    );
  },

  /** 删除 Todo */
  async delete(id: string): Promise<void> {
    return invokeOrApi<void>("delete_todo", { id }, () =>
      apiDelete(`/api/todos/${encodeURIComponent(id)}`),
    );
  },

  /** 查询 Todo 列表 */
  async query(query: TodoQuery): Promise<TodoQueryResult> {
    return invokeOrApi<TodoQueryResult>("query_todos", { query }, () =>
      apiJson<TodoQueryResult>("/api/todos/query", "POST", query),
    );
  },

  /** 重新排序 Todo */
  async reorder(todoIds: string[]): Promise<void> {
    return invokeOrApi<void>("reorder_todos", { todoIds }, () =>
      apiJson<void>("/api/todos/reorder", "POST", { todoIds }),
    );
  },

  /** 批量更新状态 */
  async batchUpdateStatus(ids: string[], status: TodoStatus): Promise<number> {
    return invokeOrApi<number>("batch_update_todo_status", { ids, status }, () =>
      apiJson<number>("/api/todos/batch-status", "POST", { ids, status }),
    );
  },

  /** 获取统计 */
  async stats(params?: {
    scope?: TodoScope;
    scopeRef?: string;
  }): Promise<TodoStats> {
    const query = {
      scope: params?.scope,
      scopeRef: params?.scopeRef,
    };
    return invokeOrApi<TodoStats>("get_todo_stats", query, () =>
      apiGet<TodoStats>("/api/todos/stats", query),
    );
  },

  /** 切换"我的一天" */
  async toggleMyDay(id: string): Promise<TodoItem> {
    return invokeOrApi<TodoItem>("toggle_todo_my_day", { id }, () =>
      apiJson<TodoItem>(`/api/todos/${encodeURIComponent(id)}/toggle-my-day`, "POST"),
    );
  },

  /** 检查到期提醒 */
  async checkReminders(): Promise<TodoItem[]> {
    return invokeOrApi<TodoItem[]>("check_todo_reminders", undefined, () =>
      apiGet<TodoItem[]>("/api/todos/reminders"),
    );
  },

  /** 获取任务活动记录 */
  async listActivities(todoId: string): Promise<TodoActivity[]> {
    return invokeOrApi<TodoActivity[]>("list_todo_activities", { todoId }, () =>
      apiGet<TodoActivity[]>(`/api/todos/${encodeURIComponent(todoId)}/activities`),
    );
  },

  // ============ Subtask (5 个) ============

  /** 添加子任务 */
  async addSubtask(todoId: string, title: string): Promise<TodoSubtask> {
    return invokeOrApi<TodoSubtask>("add_todo_subtask", { todoId, title }, () =>
      apiJson<TodoSubtask>(`/api/todos/${encodeURIComponent(todoId)}/subtasks`, "POST", { title }),
    );
  },

  /** 更新子任务 */
  async updateSubtask(
    id: string,
    title?: string,
    completed?: boolean
  ): Promise<boolean> {
    return invokeOrApi<boolean>("update_todo_subtask", { id, title, completed }, () =>
      apiJson<boolean>(`/api/todo-subtasks/${encodeURIComponent(id)}`, "PATCH", { title, completed }),
    );
  },

  /** 删除子任务 */
  async deleteSubtask(id: string): Promise<void> {
    return invokeOrApi<void>("delete_todo_subtask", { id }, () =>
      apiDelete(`/api/todo-subtasks/${encodeURIComponent(id)}`),
    );
  },

  /** 切换子任务完成状态 */
  async toggleSubtask(id: string): Promise<boolean> {
    return invokeOrApi<boolean>("toggle_todo_subtask", { id }, () =>
      apiJson<boolean>(`/api/todo-subtasks/${encodeURIComponent(id)}/toggle`, "POST"),
    );
  },

  /** 重排子任务 */
  async reorderSubtasks(subtaskIds: string[]): Promise<void> {
    return invokeOrApi<void>("reorder_todo_subtasks", { subtaskIds }, () =>
      apiJson<void>("/api/todo-subtasks/reorder", "POST", { subtaskIds }),
    );
  },
};
