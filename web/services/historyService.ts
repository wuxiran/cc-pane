import { invoke } from "@tauri-apps/api/core";
import type { CliTool } from "@/types";

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
  ): Promise<number> {
    return invoke("add_launch_history", {
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
    });
  },

  async list(limit = 20): Promise<LaunchRecord[]> {
    return invoke("list_launch_history", { limit });
  },

  async delete(id: number): Promise<void> {
    await invoke("delete_launch_history", { id });
  },

  async clear(): Promise<void> {
    await invoke("clear_launch_history");
  },

  async readSessionState(projectPath: string): Promise<SessionState | null> {
    return invoke("read_session_state", { projectPath });
  },

  async updateSessionId(id: number, resumeSessionId: string): Promise<void> {
    await invoke("update_launch_session_id", { id, resumeSessionId });
  },

  async updateLastPrompt(id: number, lastPrompt: string): Promise<void> {
    await invoke("update_launch_last_prompt", { id, lastPrompt });
  },

  async touchBySessionId(resumeSessionId: string): Promise<number | null> {
    return invoke("touch_launch_by_session", { resumeSessionId });
  },

  async detectResumeSession(
    cliTool: CliTool | string,
    runtimeKind: string | undefined,
    wslDistro: string | undefined,
    projectPath: string,
    workspacePath?: string,
    afterTs?: string,
  ): Promise<string | null> {
    return invoke("detect_resume_session", {
      cliTool,
      runtimeKind: runtimeKind ?? null,
      wslDistro: wslDistro ?? null,
      projectPath,
      workspacePath: workspacePath ?? null,
      afterTs: afterTs ?? new Date().toISOString(),
    });
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
    await invoke("start_launch_history_backfill", {
      launchId,
      ptySessionId,
      cliTool,
      runtimeKind,
      wslDistro: wslDistro ?? null,
      projectPath,
      workspacePath: workspacePath ?? null,
      afterTs: afterTs ?? null,
    });
  },
};
