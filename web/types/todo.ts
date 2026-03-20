/**
 * TodoList 看板类型定义
 *
 * 字段名使用 camelCase，与 Rust 端 #[serde(rename_all = "camelCase")] 对应。
 */

/** Todo 状态 */
export type TodoStatus = "todo" | "in_progress" | "done";

/** Todo 优先级 */
export type TodoPriority = "high" | "medium" | "low";

/** Todo 作用域 */
export type TodoScope =
  | "global"
  | "workspace"
  | "project"
  | "external"
  | "temp_script";

/** Todo 条目 */
export interface TodoItem {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  scope: TodoScope;
  scopeRef?: string;
  tags: string[];
  todoType: string;
  dueDate?: string; // RFC3339
  myDay: boolean;
  myDayDate?: string; // YYYY-MM-DD
  reminderAt?: string; // RFC3339
  recurrence?: string; // JSON
  sortOrder: number;
  createdAt: string; // RFC3339
  updatedAt: string;
  subtasks: TodoSubtask[];
}

/** Todo 子任务 */
export interface TodoSubtask {
  id: string;
  todoId: string;
  title: string;
  completed: boolean;
  sortOrder: number;
  createdAt: string;
}

/** 创建 Todo 请求 */
export interface CreateTodoRequest {
  title: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  scope?: TodoScope;
  scopeRef?: string;
  tags?: string[];
  dueDate?: string;
  reminderAt?: string;
  recurrence?: string;
  todoType?: string;
}

/** 更新 Todo 请求 */
export interface UpdateTodoRequest {
  title?: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  scope?: TodoScope;
  scopeRef?: string;
  tags?: string[];
  dueDate?: string;
  myDay?: boolean;
  myDayDate?: string;
  reminderAt?: string;
  recurrence?: string;
  todoType?: string;
}

/** Todo 查询参数 */
export interface TodoQuery {
  status?: TodoStatus;
  priority?: TodoPriority;
  scope?: TodoScope;
  scopeRef?: string;
  search?: string;
  tag?: string;
  sortBy?: string;
  limit?: number;
  offset?: number;
  myDay?: boolean;
  todoType?: string;
}

/** Todo 查询结果 */
export interface TodoQueryResult {
  items: TodoItem[];
  total: number;
  hasMore: boolean;
}

/** Todo 统计 */
export interface TodoStats {
  total: number;
  byStatus: Record<string, number>;
  byScope: Record<string, number>;
  byPriority: Record<string, number>;
  overdue: number;
}
