export interface CheckpointSnapshot {
  repositoryRoot: string;
  head: string;
  tree: string;
  fingerprint: string;
  snapshotRepository: string;
}

export interface TurnCheckpointRecord {
  id: string;
  chatId: string;
  turnId: string;
  cwd: string;
  createdAt: string;
  completedAt: string | null;
  outcome: string;
  before: CheckpointSnapshot | null;
  after: CheckpointSnapshot | null;
  unavailableReason: string | null;
  restoredAt: string | null;
}

export interface TurnCheckpointFile {
  path: string;
  status: "added" | "deleted" | "modified";
  binary: boolean;
  conflict: boolean;
  supported: boolean;
  beforeContent: string | null;
  afterContent: string | null;
  previewOmitted: boolean;
}

export interface TurnCheckpointReview {
  record: TurnCheckpointRecord;
  revision: string;
  files: TurnCheckpointFile[];
  canRestore: boolean;
  blockedReason: string | null;
}

export interface RestoreTurnCheckpointResult {
  restoredPaths: string[];
  recoveryId: string;
  warning: string | null;
}
