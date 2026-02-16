import { invoke } from "@tauri-apps/api/core";

export interface LaunchRecord {
  id: number;
  project_id: string;
  project_name: string;
  project_path: string;
  launched_at: string;
}

export const historyService = {
  async add(projectId: string, projectName: string, projectPath: string): Promise<void> {
    await invoke("add_launch_history", {
      projectId,
      projectName,
      projectPath,
    });
  },

  async list(limit = 20): Promise<LaunchRecord[]> {
    return invoke("list_launch_history", { limit });
  },

  async clear(): Promise<void> {
    await invoke("clear_launch_history");
  },
};
