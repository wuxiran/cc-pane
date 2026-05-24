import type { TaskBinding, TaskBindingNode, Workspace, WorkspaceProject } from "@/types";

export interface OrchestratorMetadataUi {
  gitBranch?: string;
  retryOf?: string;
  retriedAt?: number;
  muted?: boolean;
  startedAt?: number | string;
  isWorktree?: boolean;
  worktree?: boolean;
}

export function getMetadataUi(binding: TaskBinding): OrchestratorMetadataUi {
  const metadata = binding.metadata;
  if (!metadata || typeof metadata !== "object") return {};
  const ui = (metadata as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object") return {};
  return ui as OrchestratorMetadataUi;
}

export function getProjectName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

export function getProjectLabel(project: WorkspaceProject): string {
  return project.alias || getProjectName(project.path);
}

export function findWorkspaceProject(
  workspaces: Workspace[],
  projectPath: string | null,
): { workspace: Workspace; project: WorkspaceProject } | null {
  if (!projectPath) return null;
  for (const workspace of workspaces) {
    const project = workspace.projects.find((item) => item.path === projectPath);
    if (project) return { workspace, project };
  }
  return null;
}

export function flattenTaskTree(nodes: TaskBindingNode[]): TaskBindingNode[] {
  const result: TaskBindingNode[] = [];
  const visit = (node: TaskBindingNode) => {
    result.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const node of nodes) visit(node);
  return result;
}
