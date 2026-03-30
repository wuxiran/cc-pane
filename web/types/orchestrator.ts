export type TaskBindingStatus = "pending" | "running" | "waiting" | "completed" | "failed";

export interface TaskBinding {
  id: string;
  title: string;
  prompt?: string;
  sessionId?: string;
  todoId?: string;
  projectPath: string;
  workspaceName?: string;
  cliTool: string;
  status: TaskBindingStatus;
  progress: number;
  completionSummary?: string;
  exitCode?: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskBindingRequest {
  title: string;
  prompt?: string;
  sessionId?: string;
  todoId?: string;
  projectPath: string;
  workspaceName?: string;
  cliTool?: string;
}

export interface UpdateTaskBindingRequest {
  title?: string;
  prompt?: string;
  sessionId?: string;
  status?: TaskBindingStatus;
  progress?: number;
  completionSummary?: string;
  exitCode?: number;
  sortOrder?: number;
}

export interface TaskBindingQuery {
  status?: TaskBindingStatus;
  projectPath?: string;
  workspaceName?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface TaskBindingQueryResult {
  items: TaskBinding[];
  total: number;
  hasMore: boolean;
}
