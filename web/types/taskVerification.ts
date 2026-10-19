export type VerificationFreshness = "current" | "stale" | "unknown";

export interface RunTaskVerificationRequest {
  command: string;
  timeoutSecs?: number;
}

export interface TaskVerificationEvidence {
  id: string;
  taskId: string;
  command: string;
  cwd: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  timeoutSecs: number;
  exitCode: number | null;
  signal: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  executionError: string | null;
  originalHead: string;
  originalFingerprint: string;
  finalFingerprint: string | null;
  codeChangedDuringRun: boolean;
  observationError: string | null;
  freshness: VerificationFreshness;
}

export interface TaskVerificationReport {
  taskId: string;
  cwd: string;
  currentFingerprint: string | null;
  snapshotError: string | null;
  running: boolean;
  evidence: TaskVerificationEvidence[];
}
