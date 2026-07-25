import type { WorkspaceProject } from "@/types";

export function isRenderableWorkspaceProject(project: unknown): project is WorkspaceProject {
  return typeof project === "object"
    && project !== null
    && typeof (project as WorkspaceProject).id === "string"
    && typeof (project as WorkspaceProject).path === "string"
    && (project as WorkspaceProject).path.trim() !== "";
}

export function normalizeWorkspaceProjects(projects: unknown): WorkspaceProject[] {
  if (!Array.isArray(projects)) return [];
  const renderableProjects = projects.filter(isRenderableWorkspaceProject);
  return renderableProjects.length === projects.length ? projects : renderableProjects;
}
