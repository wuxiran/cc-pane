/** Automations（定时派 ACP agent）——镜像 src-tauri automation_service.rs */

export interface AutomationDef {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  engineId: string;
  /** 5 字段 cron（分 时 日 月 周） */
  schedule: string;
  enabled: boolean;
  graceMinutes: number;
  timeoutMinutes: number;
  autoApprove: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
}

export type AutomationRunStatus =
  | "completed"
  | "failed"
  | "skipped_missed"
  | "skipped_overlap";

export interface AutomationRun {
  id: string;
  automationId: string;
  scheduledFor: number;
  startedAt: number;
  finishedAt: number | null;
  status: AutomationRunStatus;
  stopReason?: string;
  detail?: string;
}

export const AUTOMATIONS_CHANGED_EVENT = "automations-changed";
