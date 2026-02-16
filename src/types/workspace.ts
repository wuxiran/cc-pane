export interface WorkspaceProject {
  id: string;
  path: string;
  alias?: string;
}

export interface Workspace {
  id: string;
  name: string;
  alias?: string;
  created_at: string;
  projects: WorkspaceProject[];
  provider_id?: string;
}
