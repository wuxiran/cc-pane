import { invoke } from "@tauri-apps/api/core";
import {
  apiDelete,
  apiGet,
  apiJson,
  apiNoContent,
  invokeOrApi,
  isTauriRuntime,
} from "./apiClient";
import type {
  ProjectMigrationPlan,
  ProjectMigrationRequest,
  ProjectMigrationResult,
  ProjectMigrationRollbackResult,
  Workspace,
  WorkspaceMigrationPlan,
  WorkspaceMigrationRequest,
  WorkspaceMigrationResult,
  WorkspaceMigrationRollbackResult,
  WorkspaceProject,
  SshConnectionInfo,
} from "@/types";

export async function listWorkspaces(): Promise<Workspace[]> {
  return invokeOrApi<Workspace[]>("list_workspaces", undefined, () =>
    apiGet<Workspace[]>("/api/workspaces"),
  );
}

export async function createWorkspace(name: string, path?: string | null): Promise<Workspace> {
  return invokeOrApi<Workspace>("create_workspace", { name, path }, () =>
    apiJson<Workspace>("/api/workspaces", "POST", { name, path }),
  );
}

export async function getWorkspace(name: string): Promise<Workspace> {
  return invokeOrApi<Workspace>("get_workspace", { name }, () =>
    apiGet<Workspace>(`/api/workspaces/${encodeURIComponent(name)}`),
  );
}

export async function saveWorkspace(
  name: string,
  workspace: Workspace
): Promise<void> {
  return invokeOrApi<void>("update_workspace", { name, workspace }, () =>
    apiNoContent(`/api/workspaces/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace }),
    }),
  );
}

export async function renameWorkspace(
  oldName: string,
  newName: string
): Promise<void> {
  return invokeOrApi<void>("rename_workspace", { oldName, newName }, () =>
    apiNoContent(`/api/workspaces/${encodeURIComponent(oldName)}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName }),
    }),
  );
}

export async function deleteWorkspace(name: string): Promise<void> {
  return invokeOrApi<void>("delete_workspace", { name }, () =>
    apiDelete(`/api/workspaces/${encodeURIComponent(name)}`),
  );
}

export async function addWorkspaceProject(
  workspaceName: string,
  path: string
): Promise<WorkspaceProject> {
  const project = await invokeOrApi<WorkspaceProject>(
    "add_workspace_project",
    { workspaceName, path },
    () =>
      apiJson<WorkspaceProject>(
        `/api/workspaces/${encodeURIComponent(workspaceName)}/projects`,
        "POST",
        { path },
      ),
  );
  // 初始化 Local History 监控（幂等）
  try {
    if (isTauriRuntime()) {
      await invoke("init_project_history", { projectPath: path });
    } else {
      await apiNoContent("/api/local-history/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: path }),
      });
    }
  } catch (e) {
    console.warn("Failed to init project history:", e);
  }
  return project;
}

export async function removeWorkspaceProject(
  workspaceName: string,
  projectId: string
): Promise<void> {
  return invokeOrApi<void>(
    "remove_workspace_project",
    { workspaceName, projectId },
    () =>
      apiDelete(
        `/api/workspaces/${encodeURIComponent(workspaceName)}/projects/${encodeURIComponent(projectId)}`,
      ),
  );
}

export async function updateWorkspaceAlias(
  workspaceName: string,
  alias: string | null
): Promise<void> {
  return invokeOrApi<void>("update_workspace_alias", { workspaceName, alias }, () =>
    apiNoContent(`/api/workspaces/${encodeURIComponent(workspaceName)}/alias`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias }),
    }),
  );
}

export async function updateWorkspaceProjectAlias(
  workspaceName: string,
  projectId: string,
  alias: string | null
): Promise<void> {
  return invokeOrApi<void>(
    "update_workspace_project_alias",
    {
      workspaceName,
      projectId,
      alias,
    },
    () =>
      apiNoContent(
        `/api/workspaces/${encodeURIComponent(workspaceName)}/projects/${encodeURIComponent(projectId)}/alias`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alias }),
        },
      ),
  );
}

export async function updateWorkspaceProvider(
  workspaceName: string,
  providerId: string | null
): Promise<void> {
  return invokeOrApi<void>(
    "update_workspace_provider",
    {
      workspaceName,
      providerId,
    },
    () =>
      apiNoContent(`/api/workspaces/${encodeURIComponent(workspaceName)}/provider`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      }),
  );
}

export async function updateWorkspaceLaunchProfile(
  workspaceName: string,
  launchProfileId: string | null
): Promise<void> {
  const workspace = await getWorkspace(workspaceName);
  await saveWorkspace(workspaceName, {
    ...workspace,
    launchProfileId: launchProfileId ?? undefined,
  });
}

export async function updateWorkspacePath(
  workspaceName: string,
  path: string | null
): Promise<void> {
  return invokeOrApi<void>("update_workspace_path", { workspaceName, path }, () =>
    apiNoContent(`/api/workspaces/${encodeURIComponent(workspaceName)}/path`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function previewWorkspaceMigration(
  request: WorkspaceMigrationRequest
): Promise<WorkspaceMigrationPlan> {
  return invokeOrApi<WorkspaceMigrationPlan>(
    "preview_workspace_migration",
    { request },
    () =>
      apiJson<WorkspaceMigrationPlan>(
        "/api/workspace-migrations/preview",
        "POST",
        request,
      ),
  );
}

export async function executeWorkspaceMigration(
  request: WorkspaceMigrationRequest
): Promise<WorkspaceMigrationResult> {
  return invokeOrApi<WorkspaceMigrationResult>(
    "execute_workspace_migration",
    { request },
    () =>
      apiJson<WorkspaceMigrationResult>(
        "/api/workspace-migrations/execute",
        "POST",
        request,
      ),
  );
}

export async function rollbackWorkspaceMigration(
  workspaceName: string,
  snapshotId: string
): Promise<WorkspaceMigrationRollbackResult> {
  return invokeOrApi<WorkspaceMigrationRollbackResult>(
    "rollback_workspace_migration",
    {
      workspaceName,
      snapshotId,
    },
    () =>
      apiJson<WorkspaceMigrationRollbackResult>(
        `/api/workspace-migrations/${encodeURIComponent(workspaceName)}/${encodeURIComponent(snapshotId)}/rollback`,
        "POST",
      ),
  );
}

export async function previewProjectMigration(
  request: ProjectMigrationRequest
): Promise<ProjectMigrationPlan> {
  return invokeOrApi<ProjectMigrationPlan>("preview_project_migration", { request }, () =>
    apiJson<ProjectMigrationPlan>("/api/project-migrations/preview", "POST", request),
  );
}

export async function executeProjectMigration(
  request: ProjectMigrationRequest
): Promise<ProjectMigrationResult> {
  return invokeOrApi<ProjectMigrationResult>("execute_project_migration", { request }, () =>
    apiJson<ProjectMigrationResult>("/api/project-migrations/execute", "POST", request),
  );
}

export async function rollbackProjectMigration(
  workspaceName: string,
  snapshotId: string
): Promise<ProjectMigrationRollbackResult> {
  return invokeOrApi<ProjectMigrationRollbackResult>(
    "rollback_project_migration",
    {
      workspaceName,
      snapshotId,
    },
    () =>
      apiJson<ProjectMigrationRollbackResult>(
        `/api/project-migrations/${encodeURIComponent(workspaceName)}/${encodeURIComponent(snapshotId)}/rollback`,
        "POST",
      ),
  );
}

// ============ SSH Project ============

export async function addSshProject(
  workspaceName: string,
  sshInfo: SshConnectionInfo
): Promise<WorkspaceProject> {
  return invokeOrApi<WorkspaceProject>(
    "add_ssh_project",
    {
      workspaceName,
      sshInfo,
    },
    () =>
      apiJson<WorkspaceProject>(
        `/api/workspaces/${encodeURIComponent(workspaceName)}/ssh-projects`,
        "POST",
        { sshInfo },
      ),
  );
}

// ============ Git Clone ============

export interface GitCloneRequest {
  url: string;
  targetDir: string;
  folderName: string;
  shallow: boolean;
  username?: string;
  password?: string;
}

export async function gitClone(request: GitCloneRequest): Promise<string> {
  return invoke<string>("git_clone", { request });
}

// ============ Pinned / Hidden / Reorder ============

export async function updateWorkspacePinned(
  workspaceName: string,
  pinned: boolean
): Promise<void> {
  const ws = await getWorkspace(workspaceName);
  await saveWorkspace(workspaceName, { ...ws, pinned });
}

export async function updateWorkspaceHidden(
  workspaceName: string,
  hidden: boolean
): Promise<void> {
  const ws = await getWorkspace(workspaceName);
  await saveWorkspace(workspaceName, { ...ws, hidden });
}

export async function reorderWorkspaces(
  orderedNames: string[]
): Promise<void> {
  await invokeOrApi<void>("reorder_workspaces", { orderedNames }, () =>
    apiNoContent("/api/workspaces/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedNames }),
    }),
  );
}

// ============ 目录扫描 ============

export interface ScannedWorktree {
  path: string;
  branch: string;
}

export interface ScannedRepo {
  mainPath: string;
  mainBranch: string;
  worktrees: ScannedWorktree[];
}

export async function scanDirectory(
  rootPath: string
): Promise<ScannedRepo[]> {
  return invokeOrApi<ScannedRepo[]>("scan_workspace_directory", { rootPath }, () =>
    apiGet<ScannedRepo[]>("/api/workspace-scan", { rootPath }),
  );
}
