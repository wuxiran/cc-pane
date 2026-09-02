import type { QuickCommand, QuickCommandDraft } from "@/types";
import { apiDelete, apiGet, apiJson, invokeOrApi } from "./apiClient";

export const quickCommandService = {
  listGlobal(): Promise<QuickCommand[]> {
    return invokeOrApi<QuickCommand[]>("list_quick_commands", undefined, () =>
      apiGet<QuickCommand[]>("/api/quick-commands"),
    );
  },

  createGlobal(draft: QuickCommandDraft): Promise<QuickCommand> {
    return invokeOrApi<QuickCommand>("create_quick_command", { draft }, () =>
      apiJson<QuickCommand>("/api/quick-commands", "POST", draft),
    );
  },

  updateGlobal(id: string, draft: QuickCommandDraft): Promise<QuickCommand> {
    return invokeOrApi<QuickCommand>("update_quick_command", { id, draft }, () =>
      apiJson<QuickCommand>(
        `/api/quick-commands/${encodeURIComponent(id)}`,
        "PUT",
        draft,
      ),
    );
  },

  deleteGlobal(id: string): Promise<void> {
    return invokeOrApi<void>("delete_quick_command", { id }, () =>
      apiDelete(`/api/quick-commands/${encodeURIComponent(id)}`),
    );
  },

  listWorkspace(workspaceName: string): Promise<QuickCommand[]> {
    return invokeOrApi<QuickCommand[]>(
      "list_workspace_quick_commands",
      { workspaceName },
      () => apiGet<QuickCommand[]>("/api/quick-commands/workspace", { workspaceName }),
    );
  },

  saveWorkspace(workspaceName: string, commands: QuickCommand[]): Promise<QuickCommand[]> {
    return invokeOrApi<QuickCommand[]>(
      "save_workspace_quick_commands",
      { workspaceName, commands },
      () =>
        apiJson<QuickCommand[]>("/api/quick-commands/workspace", "PUT", {
          workspaceName,
          commands,
        }),
    );
  },

  listProject(projectPath: string): Promise<QuickCommand[]> {
    return invokeOrApi<QuickCommand[]>(
      "list_project_quick_commands",
      { projectPath },
      () => apiGet<QuickCommand[]>("/api/quick-commands/project", { projectPath }),
    );
  },

  saveProject(projectPath: string, commands: QuickCommand[]): Promise<QuickCommand[]> {
    return invokeOrApi<QuickCommand[]>(
      "save_project_quick_commands",
      { projectPath, commands },
      () =>
        apiJson<QuickCommand[]>("/api/quick-commands/project", "PUT", {
          projectPath,
          commands,
        }),
    );
  },
};
