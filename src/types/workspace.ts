export interface WorkspaceProject {
  id: string;
  path: string;
  alias?: string;
}

export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  createdAt: string;
  projects: WorkspaceProject[];
  providerId?: string;
  path?: string;
}
