import { apiGet, invokeOrApi } from "./apiClient";

export interface ClaudeSession {
  id: string;
  project_path: string;
  modified_at: number;
  file_path: string;
  description: string;
  /** 会话所在的登录账号（默认目录里的会话没有）。 */
  account_id?: string;
  account_name?: string;
}

export interface BrokenSession {
  id: string;
  file_path: string;
  project_path: string;
  thinking_blocks: number;
  file_size: number;
}

export interface CleanResult {
  file_path: string;
  removed_blocks: number;
  success: boolean;
  error: string | null;
}

export const claudeService = {
  /**
   * 获取项目的 Claude 会话列表
   */
  async listSessions(projectPath: string): Promise<ClaudeSession[]> {
    return invokeOrApi<ClaudeSession[]>("list_claude_sessions", { projectPath }, () =>
      apiGet<ClaudeSession[]>("/api/claude/sessions", { projectPath }),
    );
  },

  /**
   * 获取所有 Claude 会话
   */
  async listAllSessions(): Promise<ClaudeSession[]> {
    return invokeOrApi<ClaudeSession[]>("list_all_claude_sessions", undefined, () =>
      apiGet<ClaudeSession[]>("/api/claude/sessions/all"),
    );
  },

  /**
   * 扫描含有 thinking 块的损坏会话文件
   */
  async scanBrokenSessions(projectPath?: string): Promise<BrokenSession[]> {
    return invokeOrApi<BrokenSession[]>(
      "scan_broken_sessions",
      { projectPath: projectPath || null },
      async () => [],
    );
  },

  /**
   * 清理单个会话文件
   */
  async cleanSessionFile(filePath: string): Promise<CleanResult> {
    return invokeOrApi<CleanResult>("clean_session_file", { filePath }, async () => ({
      file_path: filePath,
      removed_blocks: 0,
      success: false,
      error: "Session cleanup is only available in the desktop app",
    }));
  },

  /**
   * 批量清理所有损坏的会话文件
   */
  async cleanAllBrokenSessions(projectPath?: string): Promise<CleanResult[]> {
    return invokeOrApi<CleanResult[]>(
      "clean_all_broken_sessions",
      { projectPath: projectPath || null },
      async () => [],
    );
  },
};
