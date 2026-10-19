import type { ChatForkMode } from "@/services/chatForkService";

export interface ForkReviewRecord {
  id: string;
  createdAt: string;
  mode: ChatForkMode;
  sourceCwd: string;
  targetCwd: string;
  sourceTabId?: string;
  childTabId?: string;
  sourceSessionId?: string;
  childSessionId?: string;
  title?: string;
  engineId?: string;
  baseline: {
    repositoryRoot: string;
    head: string;
    tree: string;
    fingerprint: string;
    snapshotRepository: string;
  };
}

export interface PrepareChatForkRequest {
  cwd: string;
  mode: ChatForkMode;
  sourceTabId?: string;
  childTabId?: string;
  sourceSessionId?: string;
  title?: string;
  engineId?: string;
}

export interface PreparedChatFork {
  cwd: string;
  record: ForkReviewRecord | null;
  unavailableReason?: string;
}

export interface ForkHunk {
  id: string;
  header: string;
  patch: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ForkChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  binary: boolean;
  supported: boolean;
  wholeFileOnly?: boolean;
  reason?: string;
  parentChanged: boolean;
  conflict: boolean;
  baseContent?: string;
  childContent?: string;
  parentContent?: string;
  hunks: ForkHunk[];
}

export interface ForkComparison {
  record: ForkReviewRecord;
  revision: string;
  parentFingerprint: string;
  childFingerprint: string;
  sharedDirectory: boolean;
  files: ForkChangedFile[];
}

export interface ForkSelection {
  path: string;
  hunkIds?: string[];
}

export interface ApplyForkChangesRequest {
  revision: string;
  selections: ForkSelection[];
}

export interface ApplyForkChangesResult {
  appliedPaths: string[];
  revision: string;
  refreshWarning?: string;
}
