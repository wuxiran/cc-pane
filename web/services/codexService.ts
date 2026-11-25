import { apiGet, invokeOrApi } from "./apiClient";

/** Codex 会话（结构与后端 codex_session_service::CodexSession 对应） */
export interface CodexSession {
  id: string;
  project_path: string;
  modified_at: number;
  file_path: string;
  description: string;
  /** 会话所在的登录账号（默认目录里的会话没有）。 */
  account_id?: string;
  account_name?: string;
}

export const codexService = {
  /**
   * 获取项目的 Codex 会话列表（runtimeKind=wsl 时扫 WSL 内 ~/.codex/sessions）
   */
  async listSessions(
    projectPath: string,
    runtimeKind?: string,
    wslDistro?: string,
  ): Promise<CodexSession[]> {
    return invokeOrApi<CodexSession[]>(
      "list_codex_sessions",
      { projectPath, runtimeKind, wslDistro },
      () =>
        apiGet<CodexSession[]>("/api/codex/sessions", {
          projectPath,
          runtimeKind,
          wslDistro,
        }),
    );
  },
};
