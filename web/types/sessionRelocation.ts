/** 项目改路径后迁移历史会话（镜像 cc-panes-core session_relocation）。 */
export interface SessionRelocationRequest {
  oldPath: string;
  newPath: string;
  /** true 只预览，不落盘 */
  dryRun: boolean;
}

export interface SkippedSession {
  cli: "claude" | "codex" | string;
  sessionId: string;
  /** exists：新路径下已有同名会话；active：刚被写过；invalid：不是合法 JSONL */
  reason: "exists" | "active" | "invalid" | string;
}

export interface SessionRelocationReport {
  dryRun: boolean;
  oldPath: string;
  newPath: string;
  claudeSessions: number;
  codexSessions: number;
  skipped: SkippedSession[];
  launchHistoryRows: number;
  taskBindingRows: number;
  backupDir?: string;
  warnings: string[];
}
