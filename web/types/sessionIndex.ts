export type SessionIndexScope = "all" | "workspace" | "project";
export type SessionIndexCliTool = "claude" | "codex" | "pi" | "omp";
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
  /** CLI 自己起的会话标题（Claude 的手动命名 / ai-title、Codex 应用的 thread name）；没有则空串 */
  title?: string;
  lastSummary: string;
  messageCount: number;
  mtimeMs: number;
  size: number;
  source: SessionIndexSource;
  wslDistro: string | null;
  updatedAt: string;
  /** 这条会话在哪个登录账号的目录里；三个字段都没有 = 在 CLI 的默认目录里（默认登录）。 */
  providerId?: string;
  providerAccountId?: string;
  providerAccountName?: string;
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
