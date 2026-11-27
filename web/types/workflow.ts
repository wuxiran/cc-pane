/** 多阶段持久工作流（docs/114），与 cc-panes-core/src/models/workflow.rs 对齐。 */
export type WorkflowStatus = "running" | "waiting_approval" | "done" | "failed";
export type WorkflowStageStatus = "pending" | "running" | "waiting_approval" | "done" | "failed";
export type WorkflowTaskStatus = "pending" | "claimed" | "running" | "done" | "failed";

export interface WorkflowTask {
  key: string;
  pool: string;
  status: WorkflowTaskStatus;
  bindingId?: string;
  result?: unknown;
  error?: string;
}

export interface WorkflowStage {
  index: number;
  key: string;
  title?: string;
  requiresApproval: boolean;
  status: WorkflowStageStatus;
  approvedAt?: string;
  approvedVia?: string;
  error?: string;
  tasks: WorkflowTask[];
}

/** id = 父 TaskBinding id。 */
export interface Workflow {
  id: string;
  status: WorkflowStatus;
  pools: Record<string, number>;
  stages: WorkflowStage[];
  createdAt: string;
  updatedAt: string;
}
