import { invoke } from "@tauri-apps/api/core";

export interface LaunchRecord {
  id: number;
  projectId: string;
  projectName: string;
  projectPath: string;
  launchedAt: string;
  claudeSessionId?: string;
  lastPrompt?: string;
  workspaceName?: string;
  workspacePath?: string;
  launchCwd?: string;
  providerId?: string;
}

export interface SessionState {
  claudeSessionId?: string;
  startedAt?: string;
  status?: string;
  lastPrompt?: string;
}

export const historyService = {
  async add(projectId: string, projectName: string, projectPath: string, workspaceName?: string, workspacePath?: string, launchCwd?: string, providerId?: string): Promise<number> {
    return invoke("add_launch_history", {
      projectId,
      projectName,
      projectPath,
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

  async updateSessionId(id: number, claudeSessionId: string): Promise<void> {
    await invoke("update_launch_session_id", { id, claudeSessionId });
  },

  async updateLastPrompt(id: number, lastPrompt: string): Promise<void> {
    await invoke("update_launch_last_prompt", { id, lastPrompt });
  },

  async touchBySessionId(claudeSessionId: string): Promise<number | null> {
    return invoke("touch_launch_by_session", { claudeSessionId });
  },

  async detectClaudeSession(projectPath: string, workspacePath?: string, afterTs?: string): Promise<string | null> {
    return invoke("detect_claude_session", {
      projectPath,
      workspacePath: workspacePath ?? null,
      afterTs: afterTs ?? new Date().toISOString(),
    });
  },
};
