export type SessionIndexScope = "all" | "workspace" | "project";
export type SessionIndexCliTool = "claude" | "codex";
export type SessionIndexSource = "local" | "wsl";

export interface SessionIndexEntry {
  sessionId: string;
  cliTool: SessionIndexCliTool;
  filePath: string;
  cwd: string;
  projectPathNorm: string;
  projectName: string;
  workspaceName: string | null;
  firstPrompt: string;
  lastSummary: string;
  messageCount: number;
  mtimeMs: number;
  size: number;
  source: SessionIndexSource;
  wslDistro: string | null;
  updatedAt: string;
}

export interface SessionIndexListParams {
  scope: SessionIndexScope;
  workspaceName?: string;
  projectPath?: string;
  query?: string;
  cliFilter?: SessionIndexCliTool;
  limit?: number;
  offset?: number;
}

export interface SessionIndexScanReport {
  rootsScanned: number;
  filesSeen: number;
  filesParsed: number;
  filesSkipped: number;
  bytesRead: number;
}
