import { invoke } from "@tauri-apps/api/core";
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
  return invoke<Workspace[]>("list_workspaces");
}

export async function createWorkspace(name: string, path?: string | null): Promise<Workspace> {
  return invoke<Workspace>("create_workspace", { name, path });
}

export async function getWorkspace(name: string): Promise<Workspace> {
  return invoke<Workspace>("get_workspace", { name });
}

export async function saveWorkspace(
  name: string,
  workspace: Workspace
): Promise<void> {
  return invoke("update_workspace", { name, workspace });
}

export async function renameWorkspace(
  oldName: string,
  newName: string
): Promise<void> {
  return invoke("rename_workspace", { oldName, newName });
}

export async function deleteWorkspace(name: string): Promise<void> {
  return invoke("delete_workspace", { name });
}

export async function addWorkspaceProject(
  workspaceName: string,
  path: string
): Promise<WorkspaceProject> {
  const project = await invoke<WorkspaceProject>("add_workspace_project", {
    workspaceName,
    path,
  });
  // 初始化 Local History 监控（幂等）
  try {
    await invoke("init_project_history", { projectPath: path });
  } catch (e) {
    console.warn("Failed to init project history:", e);
  }
  return project;
}

export async function removeWorkspaceProject(
  workspaceName: string,
  projectId: string
): Promise<void> {
  return invoke("remove_workspace_project", { workspaceName, projectId });
}

export async function updateWorkspaceAlias(
  workspaceName: string,
  alias: string | null
): Promise<void> {
  return invoke("update_workspace_alias", { workspaceName, alias });
}

export async function updateWorkspaceProjectAlias(
  workspaceName: string,
  projectId: string,
  alias: string | null
): Promise<void> {
  return invoke("update_workspace_project_alias", {
    workspaceName,
    projectId,
    alias,
  });
}

export async function updateWorkspaceProvider(
  workspaceName: string,
  providerId: string | null
): Promise<void> {
  return invoke("update_workspace_provider", {
    workspaceName,
    providerId,
  });
}

export async function updateWorkspacePath(
  workspaceName: string,
  path: string | null
): Promise<void> {
  return invoke("update_workspace_path", { workspaceName, path });
}

export async function previewWorkspaceMigration(
  request: WorkspaceMigrationRequest
): Promise<WorkspaceMigrationPlan> {
  return invoke<WorkspaceMigrationPlan>("preview_workspace_migration", { request });
}

export async function executeWorkspaceMigration(
  request: WorkspaceMigrationRequest
): Promise<WorkspaceMigrationResult> {
  return invoke<WorkspaceMigrationResult>("execute_workspace_migration", { request });
}

export async function rollbackWorkspaceMigration(
  workspaceName: string,
  snapshotId: string
): Promise<WorkspaceMigrationRollbackResult> {
  return invoke<WorkspaceMigrationRollbackResult>("rollback_workspace_migration", {
    workspaceName,
    snapshotId,
  });
}

export async function previewProjectMigration(
  request: ProjectMigrationRequest
): Promise<ProjectMigrationPlan> {
  return invoke<ProjectMigrationPlan>("preview_project_migration", { request });
}

export async function executeProjectMigration(
  request: ProjectMigrationRequest
): Promise<ProjectMigrationResult> {
  return invoke<ProjectMigrationResult>("execute_project_migration", { request });
}

export async function rollbackProjectMigration(
  workspaceName: string,
  snapshotId: string
): Promise<ProjectMigrationRollbackResult> {
  return invoke<ProjectMigrationRollbackResult>("rollback_project_migration", {
    workspaceName,
    snapshotId,
  });
}

// ============ SSH Project ============

export async function addSshProject(
  workspaceName: string,
  sshInfo: SshConnectionInfo
): Promise<WorkspaceProject> {
  return invoke<WorkspaceProject>("add_ssh_project", {
    workspaceName,
    sshInfo,
  });
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
  await invoke("update_workspace", {
    name: workspaceName,
    workspace: { ...ws, pinned },
  });
}

export async function updateWorkspaceHidden(
  workspaceName: string,
  hidden: boolean
): Promise<void> {
  const ws = await getWorkspace(workspaceName);
  await invoke("update_workspace", {
    name: workspaceName,
    workspace: { ...ws, hidden },
  });
}

export async function reorderWorkspaces(
  orderedNames: string[]
): Promise<void> {
  await invoke("reorder_workspaces", { orderedNames });
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
  return invoke<ScannedRepo[]>("scan_workspace_directory", { rootPath });
}
