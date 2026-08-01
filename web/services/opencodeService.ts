import { apiGet, invokeOrApi } from "./apiClient";

// 与 `codexService.ts` 同构（同一套 listSessions 签名与 invoke/HTTP 双通道），
// 从 feat/opencode-parity 分支逐项抽取——该分支其余部分已被 main 更新的实现取代。

/** OpenCode 会话（结构与后端 opencode_session_service::OpenCodeSession 对应） */
export interface OpenCodeSession {
  id: string;
  project_path: string;
  modified_at: number;
  file_path: string;
  description: string;
}

export const opencodeService = {
  /**
   * 获取项目的 OpenCode 会话列表。
   */
  async listSessions(
    projectPath: string,
    runtimeKind?: string,
    wslDistro?: string,
  ): Promise<OpenCodeSession[]> {
    return invokeOrApi<OpenCodeSession[]>(
      "list_opencode_sessions",
      { projectPath, runtimeKind, wslDistro },
      () =>
        apiGet<OpenCodeSession[]>("/api/opencode/sessions", {
          projectPath,
          runtimeKind,
          wslDistro,
        }),
    );
  },
};
