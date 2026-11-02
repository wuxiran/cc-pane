export type AcpRunStatus = "running" | "completed" | "cancelled" | "failed" | "interrupted";

export interface AcpRunRecord {
  id: string;
  chatId: string;
  engineId: string;
  acpSessionId: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number | null;
  status: AcpRunStatus;
  checkpointId?: string | null;
  recordingError?: string | null;
  eventCount: number;
}

export interface AcpRunEvent {
  seq: number;
  at: number;
  kind: string;
  payload: unknown;
}

export interface AcpRunQuery {
  chatId?: string;
  engineId?: string;
  acpSessionId?: string;
  offset?: number;
}

export interface AcpRunPage { runs: AcpRunRecord[]; hasMore: boolean }
export interface AcpRunEventPage { events: AcpRunEvent[]; hasMore: boolean }
