import { invoke } from "@tauri-apps/api/core";
import type {
  SpecEntry,
  SpecStatus,
  CreateSpecRequest,
  UpdateSpecRequest,
} from "@/types/spec";

export const specService = {
  async create(request: CreateSpecRequest): Promise<SpecEntry> {
    return invoke<SpecEntry>("create_spec", { request });
  },

  async list(
    projectPath: string,
    status?: SpecStatus
  ): Promise<SpecEntry[]> {
    return invoke<SpecEntry[]>("list_specs", { projectPath, status });
  },

  async getContent(
    projectPath: string,
    specId: string
  ): Promise<string> {
    return invoke<string>("get_spec_content", { projectPath, specId });
  },

  async saveContent(
    projectPath: string,
    specId: string,
    content: string
  ): Promise<void> {
    return invoke<void>("save_spec_content", {
      projectPath,
      specId,
      content,
    });
  },

  async update(
    specId: string,
    request: UpdateSpecRequest
  ): Promise<SpecEntry> {
    return invoke<SpecEntry>("update_spec", { specId, request });
  },

  async delete(projectPath: string, specId: string): Promise<void> {
    return invoke<void>("delete_spec", { projectPath, specId });
  },

  async syncTasks(
    projectPath: string,
    specId: string
  ): Promise<void> {
    return invoke<void>("sync_spec_tasks", { projectPath, specId });
  },
};
