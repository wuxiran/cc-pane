import type { TaskBinding, TaskBindingChangedEvent, TaskBindingNode, TaskBindingRole, CreateTaskBindingRequest,
  TaskBindingPatch, UpdateTaskBindingRequest, TaskBindingQuery } from "@/types";
export type FilterTab = "all" | "running" | "completed";
export type OrchestratorViewType = "list" | "tree";
export interface OrchestratorState {
  // 数据
  bindings: TaskBinding[];
  total: number;
  hasMore: boolean;
  pageLimit: number;
  loading: boolean;
  loadedWindowSize: number;
  loadError: string | null;
  failedWindowSize: number | null;
  baseOffset: number;
  queryOverrides: TaskBindingQuery;
  filterGeneration: number;
  requestGeneration: number;
  mutationVersion: number;
  queryCommitVersion: number;
  knownBindings: Record<string, TaskBinding | null>;
  mutationVersions: Record<string, number>;

  // 过滤
  filterTab: FilterTab;
  filterWorkspace: string | null;
  filterProjectPath: string | null;
  filterRole: TaskBindingRole | null;
  searchKeyword: string;

  // 输入目标
  lastTargetProjectPath: string | null;

  // 视图状态
  viewType: OrchestratorViewType;
  selectedTaskId: string | null;

  // Actions
  loadBindings: (query?: TaskBindingQuery) => Promise<void>;
  loadMoreBindings: () => Promise<void>;
  retryBindings: () => Promise<void>;
  create: (request: CreateTaskBindingRequest) => Promise<TaskBinding>;
  update: (id: string, request: UpdateTaskBindingRequest) => Promise<TaskBinding>;
  updatePatch: (id: string, patch: TaskBindingPatch) => Promise<TaskBinding>;
  remove: (id: string) => Promise<void>;
  removeCascade: (id: string) => Promise<void>;
  applyChangedEvent: (event: TaskBindingChangedEvent) => void;
  setFilterTab: (tab: FilterTab) => void;
  setFilterWorkspace: (workspace: string | null) => void;
  setFilterProjectPath: (projectPath: string | null) => void;
  setFilterRole: (role: TaskBindingRole | null) => void;
  setSearchKeyword: (keyword: string) => void;
  setLastTargetProjectPath: (projectPath: string | null) => void;
  setViewType: (viewType: OrchestratorViewType) => void;
  setSelectedTaskId: (id: string | null) => void;
  getTaskTree: () => TaskBindingNode[];
  getVisibleBindings: () => TaskBinding[];
  getActivityBadge: () => { failed: boolean; activeCount: number };

  // 通过 sessionId 更新状态（同步 hook 使用）
  updateBySessionId: (
    sessionId: string,
    updates: TaskBindingPatch
  ) => Promise<void>;
}


export type OrchestratorSet = (update: (state: OrchestratorState) => void) => void;
export type OrchestratorGet = () => OrchestratorState;
