export type SpecStatus = "draft" | "active" | "archived";

export interface SpecEntry {
  id: string;
  projectPath: string;
  title: string;
  fileName: string;
  status: SpecStatus;
  todoId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateSpecRequest {
  projectPath: string;
  title: string;
  tasks?: string[];
}

export interface UpdateSpecRequest {
  title?: string;
  status?: SpecStatus;
}

export interface SpecSummary {
  specId: string;
  title: string;
  filePath: string;
  tasksSummary: string;
}
