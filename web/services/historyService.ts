import type { CliTool, LaunchProviderSelection } from "@/types";
import { apiDelete, apiGet, apiJson, apiNoContent, invokeOrApi } from "./apiClient";

export interface LaunchRecord {
  id: number;
  projectId: string;
  projectName: string;
  projectPath: string;
  launchedAt: string;
  resumeSessionId?: string;
  cliTool?: string;
  runtimeKind?: string;
  wslDistro?: string;
  lastPrompt?: string;
  workspaceName?: string;
  workspacePath?: string;
  launchCwd?: string;
  providerId?: string;
  modelId?: string | null;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspaceSnapshotId?: string;
}

export interface SessionState {
  resumeSessionId?: string;
  cliTool?: string;
  runtimeKind?: string;
  wslDistro?: string;
  startedAt?: string;
  status?: string;
  lastPrompt?: string;
}

export const historyService = {
  async add(
    projectId: string,
    projectName: string,
    projectPath: string,
    cliTool: string,
    runtimeKind: string,
    wslDistro?: string,
    workspaceName?: string,
    workspacePath?: string,
    launchCwd?: string,
    providerId?: string,
    modelId?: string,
    providerSelection?: LaunchProviderSelection,
    workspaceSnapshotId?: string,
    launchProfileId?: string,
  ): Promise<number> {
    const payload = {
      projectId,
      projectName,
      projectPath,
      cliTool,
      runtimeKind,
      wslDistro: wslDistro ?? null,
      workspaceName: workspaceName ?? null,
      workspacePath: workspacePath ?? null,
      launchCwd: launchCwd ?? null,
      providerId: providerId ?? null,
      modelId: modelId ?? null,
      providerSelection: providerSelection ?? null,
      launchProfileId: launchProfileId ?? null,
      workspaceSnapshotId: workspaceSnapshotId ?? null,
    };
    return invokeOrApi<number>("add_launch_history", payload, () =>
      apiJson<number>("/api/launch-history", "POST", payload),
    );
  },

  async list(limit = 20): Promise<LaunchRecord[]> {
    return invokeOrApi<LaunchRecord[]>("list_launch_history", { limit }, () =>
      apiGet<LaunchRecord[]>("/api/launch-history", { limit }),
    );
  },

  async delete(id: number): Promise<void> {
    await invokeOrApi<void>("delete_launch_history", { id }, () =>
      apiDelete(`/api/launch-history/${id}`),
    );
  },

  async clear(): Promise<void> {
    await invokeOrApi<void>("clear_launch_history", undefined, () =>
      apiDelete("/api/launch-history"),
    );
  },

  async readSessionState(projectPath: string): Promise<SessionState | null> {
    return invokeOrApi<SessionState | null>("read_session_state", { projectPath }, () =>
      apiGet<SessionState | null>("/api/session-state", { projectPath }),
    );
  },

  async updateSessionId(id: number, resumeSessionId: string): Promise<void> {
    await invokeOrApi<void>("update_launch_session_id", { id, resumeSessionId }, () =>
      apiNoContent(`/api/launch-history/${id}/session-id`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeSessionId }),
      }),
    );
  },

  /** 标记启动记录的 resume id 来源（manual 手动绑定等） */
  async updateResumeSource(id: number, source: string): Promise<void> {
    await invokeOrApi<void>("update_launch_resume_source", { id, source }, () =>
      apiNoContent(`/api/launch-history/${id}/resume-source`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      }),
    );
  },

  async updateLastPrompt(id: number, lastPrompt: string): Promise<void> {
    await invokeOrApi<void>("update_launch_last_prompt", { id, lastPrompt }, () =>
      apiNoContent(`/api/launch-history/${id}/last-prompt`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastPrompt }),
      }),
    );
  },

  async touchBySessionId(resumeSessionId: string): Promise<number | null> {
    return invokeOrApi<number | null>("touch_launch_by_session", { resumeSessionId }, () =>
      apiJson<number | null>("/api/launch-history/touch-by-session", "POST", { resumeSessionId }),
    );
  },

  async detectResumeSession(
    cliTool: CliTool | string,
    runtimeKind: string | undefined,
    wslDistro: string | undefined,
    projectPath: string,
    workspacePath?: string,
    afterTs?: string,
  ): Promise<string | null> {
    return invokeOrApi<string | null>(
      "detect_resume_session",
      {
        cliTool,
        runtimeKind: runtimeKind ?? null,
        wslDistro: wslDistro ?? null,
        projectPath,
        workspacePath: workspacePath ?? null,
        afterTs: afterTs ?? new Date().toISOString(),
      },
      async () => null,
    );
  },

  async startLaunchHistoryBackfill(
    launchId: string,
    ptySessionId: string,
    cliTool: CliTool | string,
    runtimeKind: string,
    wslDistro: string | undefined,
    projectPath: string,
    workspacePath?: string,
    afterTs?: string,
  ): Promise<void> {
    await invokeOrApi<void>(
      "start_launch_history_backfill",
      {
      cliTool,
      runtimeKind: runtimeKind ?? null,
      wslDistro: wslDistro ?? null,
      projectPath,
      workspacePath: workspacePath ?? null,
      launchId,
      ptySessionId,
      afterTs: afterTs ?? null,
      },
      async () => {},
    );
  },
};
