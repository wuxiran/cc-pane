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
  completion?: TaskCompletionReport;
}

export type CompletionCheckStatus = "not_configured" | "missing" | "running" | "passed" | "failed" | "stale" | "unknown";

export interface TaskCompletionCriteria {
  definitionOfDone: string;
  requiredCommands: string[];
}

export interface TaskCompletionAcceptance {
  acceptedAt: string;
  note: string;
  criteriaRevision: number;
  reportRevision: number;
  fingerprint: string | null;
  evidenceIds: string[];
}

export interface TaskCompletionReport {
  criteria: TaskCompletionCriteria;
  criteriaRevision: number;
  reportRevision: number;
  agentFinished: boolean;
  codeFingerprint: string | null;
  checksStatus: CompletionCheckStatus;
  checks: { command: string; evidenceId: string | null; status: CompletionCheckStatus }[];
  acceptance: TaskCompletionAcceptance | null;
  userAccepted: boolean;
  canAccept: boolean;
}

export interface SetTaskCompletionCriteriaRequest {
  expectedRevision: number;
  criteria: TaskCompletionCriteria;
}

export interface AcceptTaskCompletionRequest {
  expectedCriteriaRevision: number;
  expectedReportRevision: number;
  expectedFingerprint: string | null;
  expectedEvidenceIds: string[];
  note: string;
}
