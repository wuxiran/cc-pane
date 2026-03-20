/**
 * Todo 服务层 — 封装所有 Todo 相关的 Tauri invoke 调用
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  TodoItem,
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
    return invoke<TodoItem>("create_todo", { request });
  },

  /** 获取单个 Todo */
  async get(id: string): Promise<TodoItem | null> {
    return invoke<TodoItem | null>("get_todo", { id });
  },

  /** 更新 Todo */
  async update(id: string, request: UpdateTodoRequest): Promise<TodoItem> {
    return invoke<TodoItem>("update_todo", { id, request });
  },

  /** 删除 Todo */
  async delete(id: string): Promise<void> {
    return invoke<void>("delete_todo", { id });
  },

  /** 查询 Todo 列表 */
  async query(query: TodoQuery): Promise<TodoQueryResult> {
    return invoke<TodoQueryResult>("query_todos", { query });
  },

  /** 重新排序 Todo */
  async reorder(todoIds: string[]): Promise<void> {
    return invoke<void>("reorder_todos", { todoIds });
  },

  /** 批量更新状态 */
  async batchUpdateStatus(ids: string[], status: TodoStatus): Promise<number> {
    return invoke<number>("batch_update_todo_status", { ids, status });
  },

  /** 获取统计 */
  async stats(params?: {
    scope?: TodoScope;
    scopeRef?: string;
  }): Promise<TodoStats> {
    return invoke<TodoStats>("get_todo_stats", {
      scope: params?.scope,
      scopeRef: params?.scopeRef,
    });
  },

  /** 切换"我的一天" */
  async toggleMyDay(id: string): Promise<TodoItem> {
    return invoke<TodoItem>("toggle_todo_my_day", { id });
  },

  /** 检查到期提醒 */
  async checkReminders(): Promise<TodoItem[]> {
    return invoke<TodoItem[]>("check_todo_reminders");
  },

  // ============ Subtask (5 个) ============

  /** 添加子任务 */
  async addSubtask(todoId: string, title: string): Promise<TodoSubtask> {
    return invoke<TodoSubtask>("add_todo_subtask", { todoId, title });
  },

  /** 更新子任务 */
  async updateSubtask(
    id: string,
    title?: string,
    completed?: boolean
  ): Promise<boolean> {
    return invoke<boolean>("update_todo_subtask", { id, title, completed });
  },

  /** 删除子任务 */
  async deleteSubtask(id: string): Promise<void> {
    return invoke<void>("delete_todo_subtask", { id });
  },

  /** 切换子任务完成状态 */
  async toggleSubtask(id: string): Promise<boolean> {
    return invoke<boolean>("toggle_todo_subtask", { id });
  },

  /** 重排子任务 */
  async reorderSubtasks(subtaskIds: string[]): Promise<void> {
    return invoke<void>("reorder_todo_subtasks", { subtaskIds });
  },
};
