export type TaskBindingStatus = "pending" | "running" | "waiting" | "completed" | "failed";
export type TaskBindingRole = "task" | "leader" | "worker";

export interface TaskBinding {
  id: string;
  title: string;
  role: TaskBindingRole;
  parentId?: string;
  planPath?: string;
  normalizedPlanPath?: string;
  prompt?: string;
  sessionId?: string;
  resumeId?: string;
  paneId?: string;
  tabId?: string;
  todoId?: string;
  projectPath: string;
  workspaceName?: string;
  cliTool: string;
  status: TaskBindingStatus;
  progress: number;
  completionSummary?: string;
  exitCode?: number;
  sortOrder: number;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBindingNode extends TaskBinding {
  children: TaskBindingNode[];
  depth: number;
}

export interface CreateTaskBindingRequest {
  title: string;
  role?: TaskBindingRole;
  parentId?: string;
  planPath?: string;
  normalizedPlanPath?: string;
  prompt?: string;
  sessionId?: string;
  resumeId?: string;
  paneId?: string;
  tabId?: string;
  todoId?: string;
  projectPath: string;
  workspaceName?: string;
  cliTool?: string;
  metadata?: unknown;
}

export interface UpdateTaskBindingRequest {
  title?: string;
  role?: TaskBindingRole;
  parentId?: string;
  planPath?: string;
  normalizedPlanPath?: string;
  prompt?: string;
  sessionId?: string;
  resumeId?: string;
  paneId?: string;
  tabId?: string;
  status?: TaskBindingStatus;
  progress?: number;
  completionSummary?: string;
  exitCode?: number;
  sortOrder?: number;
  metadata?: unknown;
}

// fix(C1) review: patch 类型只暴露后端白名单字段，关键绑定字段必须走受控路径。
export type TaskBindingPatch = Partial<
  Pick<
    UpdateTaskBindingRequest,
    | "title"
    | "status"
    | "progress"
    | "completionSummary"
    | "exitCode"
    | "sortOrder"
    | "metadata"
    | "prompt"
  >
>;

export type TaskBindingChangedOp = "create" | "update" | "delete" | "register" | "reconcile";

export interface TaskBindingChangedEvent {
  op: TaskBindingChangedOp;
  id: string;
  binding?: TaskBinding;
}

export interface TaskBindingQuery {
  status?: TaskBindingStatus;
  role?: TaskBindingRole;
  parentId?: string;
  planPath?: string;
  normalizedPlanPath?: string;
  resumeId?: string;
  paneId?: string;
  sessionId?: string;
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

export interface RegisterPlanLeaderRequest {
  planPath: string;
  projectPath: string;
  title?: string;
  prompt?: string;
  sessionId?: string;
  resumeId?: string;
  paneId?: string;
  tabId?: string;
  workspaceName?: string;
  cliTool?: string;
  metadata?: unknown;
}

export interface RegisterPlanWorkerRequest {
  leaderId?: string;
  planPath?: string;
  sessionId: string;
  projectPath: string;
  title?: string;
  prompt?: string;
  resumeId?: string;
  paneId?: string;
  tabId?: string;
  workspaceName?: string;
  cliTool?: string;
  metadata?: unknown;
}

export interface PlanCollaborationKey {
  leaderId?: string;
  planPath?: string;
  normalizedPlanPath?: string;
}

export interface PlanCollaborationEntry {
  id: string;
  title: string;
  role: TaskBindingRole;
  parentId?: string;
  planPath?: string;
  normalizedPlanPath?: string;
  projectPath: string;
  workspaceName?: string;
  cliTool: string;
  status: TaskBindingStatus;
  progress: number;
  sessionId?: string;
  resumeId?: string;
  paneId?: string;
  tabId?: string;
  isLive: boolean;
  canRelaunch: boolean;
  livePaneId?: string;
  liveTabId?: string;
  prompt?: string;
  completionSummary?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PlanCollaboration {
  leader: PlanCollaborationEntry;
  workers: PlanCollaborationEntry[];
  total: number;
}
