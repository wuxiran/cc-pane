import { create } from "zustand";
import type {
  SshConnectionInfo,
  Workspace,
  WorkspaceColor,
  WorkspaceProject,
} from "@/types";
import * as workspaceService from "@/services/workspaceService";
import { detectAppPlatform } from "@/utils";

export const UNGROUPED_WORKSPACE_FILTER = "__ungrouped__";

export interface WorkspaceFilter {
  query: string;
  colors: WorkspaceColor[];
  group: string | null;
  /** 是否显示已归档（逻辑删除）的工作空间。默认 false —— 归档的语义就是"从列表里消失"。 */
  includeArchived: boolean;
}

const EMPTY_WORKSPACE_FILTER: WorkspaceFilter = {
  query: "",
  colors: [],
  group: null,
  includeArchived: false,
};

export function normalizedWorkspaceGroup(workspace: Workspace): string | null {
  const group = workspace.group?.trim();
  return group || null;
}

export function filterWorkspaces(
  workspaces: Workspace[],
  filter: WorkspaceFilter,
): Workspace[] {
  const query = filter.query.trim().toLocaleLowerCase();
  const selectedColors = new Set(filter.colors);

  return workspaces.filter((workspace) => {
    // 归档判定必须在 isDefault 短路之前：默认工作空间虽然禁止归档，但若历史数据
    // 里已带 archivedAt，短路会让它绕过过滤永远露出来。
    if (!filter.includeArchived && workspace.archivedAt) return false;

    if (workspace.isDefault) return true;

    const matchesQuery = !query
      || workspace.name.toLocaleLowerCase().includes(query)
      || workspace.alias?.toLocaleLowerCase().includes(query);
    const matchesColor = selectedColors.size === 0
      || (workspace.color != null && selectedColors.has(workspace.color));
    const group = normalizedWorkspaceGroup(workspace);
    const matchesGroup = filter.group == null
      || (filter.group === UNGROUPED_WORKSPACE_FILTER
        ? group == null
        : group === filter.group);

    return !!matchesQuery && matchesColor && matchesGroup;
  });
}

interface WorkspacesState {
  workspaces: Workspace[];
  workspaceFilter: WorkspaceFilter;
  expandedWorkspaceId: string | null;
  expandedProjectId: string | null;
  loading: boolean;
  selectedWorkspace: () => Workspace | undefined;
  selectedProject: () => WorkspaceProject | null;
  pinnedWorkspaces: () => Workspace[];
  unpinnedVisibleWorkspaces: () => Workspace[];
  hiddenWorkspaces: () => Workspace[];
  filteredWorkspaces: () => Workspace[];
  setWorkspaceFilter: (filter: Partial<WorkspaceFilter>) => void;
  clearWorkspaceFilter: () => void;
  load: () => Promise<void>;
  create: (name: string, path?: string | null) => Promise<Workspace>;
  rename: (oldName: string, newName: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  addProject: (workspaceName: string, path: string) => Promise<WorkspaceProject>;
  addSshProject: (workspaceName: string, sshInfo: SshConnectionInfo) => Promise<WorkspaceProject>;
  removeProject: (workspaceName: string, projectId: string) => Promise<void>;
  updateProjectAlias: (workspaceName: string, projectId: string, alias: string | null) => Promise<void>;
  updateWorkspaceAlias: (workspaceName: string, alias: string | null) => Promise<void>;
  updateWorkspaceProvider: (workspaceName: string, providerId: string | null) => Promise<void>;
  updateWorkspaceLaunchProfile: (workspaceName: string, launchProfileId: string | null) => Promise<void>;
  updateWorkspacePath: (workspaceName: string, path: string | null) => Promise<void>;
  refreshWorkspace: (workspaceId: string) => Promise<Workspace | undefined>;
  saveWorkspace: (workspace: Workspace) => Promise<void>;
  updatePinned: (name: string, pinned: boolean) => Promise<void>;
  updateHidden: (name: string, hidden: boolean) => Promise<void>;
  setArchived: (name: string, archived: boolean) => Promise<void>;
  setProjectArchived: (
    workspaceName: string,
    projectId: string,
    archived: boolean
  ) => Promise<void>;
  reorder: (orderedNames: string[]) => Promise<void>;
  expandWorkspace: (id: string | null) => void;
  expandProject: (id: string | null) => void;
}

function normalizeProjectPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return detectAppPlatform() === "windows"
    ? normalized.toLowerCase()
    : normalized;
}

function mergeWorkspaceProject(
  projects: WorkspaceProject[],
  nextProject: WorkspaceProject,
): WorkspaceProject[] {
  const normalizedNextPath = normalizeProjectPath(nextProject.path);
  let replaced = false;

  const merged = projects.map((project) => {
    const sameProject = project.id === nextProject.id
      || normalizeProjectPath(project.path) === normalizedNextPath;
    if (!sameProject) {
      return project;
    }
    replaced = true;
    return nextProject;
  });

  return replaced ? merged : [...projects, nextProject];
}

function mergeWorkspace(
  workspaces: Workspace[],
  nextWorkspace: Workspace,
): Workspace[] {
  let replaced = false;

  const merged = workspaces.map((workspace) => {
    const sameWorkspace = workspace.id === nextWorkspace.id
      || workspace.name === nextWorkspace.name;
    if (!sameWorkspace) {
      return workspace;
    }
    replaced = true;
    return nextWorkspace;
  });

  return replaced ? merged : [...merged, nextWorkspace];
}

function reorderWorkspaceList(
  workspaces: Workspace[],
  orderedNames: string[],
): Workspace[] {
  const workspaceMap = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const ordered = orderedNames
    .map((name) => workspaceMap.get(name))
    .filter((workspace): workspace is Workspace => workspace !== undefined);
  const orderedSet = new Set(orderedNames);
  const remaining = workspaces.filter((workspace) => !orderedSet.has(workspace.name));
  return [...ordered, ...remaining];
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  workspaceFilter: EMPTY_WORKSPACE_FILTER,
  expandedWorkspaceId: null,
  expandedProjectId: null,
  loading: false,

  selectedWorkspace: () => {
    const { workspaces, expandedWorkspaceId } = get();
    return workspaces.find((ws) => ws.id === expandedWorkspaceId);
  },

  selectedProject: () => {
    const ws = get().selectedWorkspace();
    const pid = get().expandedProjectId;
    if (!ws || !pid) return null;
    return ws.projects.find((p) => p.id === pid) ?? null;
  },

  pinnedWorkspaces: () => {
    return get().workspaces.filter((ws) => ws.pinned);
  },

  unpinnedVisibleWorkspaces: () => {
    return get().workspaces.filter((ws) => !ws.pinned && !ws.hidden);
  },

  hiddenWorkspaces: () => {
    return get().workspaces.filter((ws) => ws.hidden);
  },

  filteredWorkspaces: () => {
    const { workspaces, workspaceFilter } = get();
    return filterWorkspaces(workspaces, workspaceFilter);
  },

  setWorkspaceFilter: (filter) => {
    set((state) => ({
      workspaceFilter: {
        ...state.workspaceFilter,
        ...filter,
        colors: filter.colors
          ? [...new Set(filter.colors)]
          : state.workspaceFilter.colors,
      },
    }));
  },

  clearWorkspaceFilter: () => {
    set({ workspaceFilter: { ...EMPTY_WORKSPACE_FILTER, colors: [] } });
  },

  load: async () => {
    set({ loading: true });
    try {
      const workspaces = await workspaceService.listWorkspaces();
      // invoke 返回 undefined（测试 mock、后端异常）时绝不能把 store 置成
      // undefined——消费方全是 .length/.filter，undefined 会在渲染层炸成循环。
      set({ workspaces: Array.isArray(workspaces) ? workspaces : [] });
    } finally {
      set({ loading: false });
    }
  },

  create: async (name, path) => {
    const ws = await workspaceService.createWorkspace(name, path);
    set((state) => ({ workspaces: mergeWorkspace(state.workspaces, ws) }));
    return ws;
  },

  rename: async (oldName, newName) => {
    await workspaceService.renameWorkspace(oldName, newName);
    await get().load();
  },

  remove: async (name) => {
    await workspaceService.deleteWorkspace(name);
    set((state) => {
      const workspaces = state.workspaces.filter((ws) => ws.name !== name);
      const removed = state.workspaces.find((ws) => ws.name === name);
      const isSelected = removed != null && state.expandedWorkspaceId === removed.id;
      return {
        workspaces,
        expandedWorkspaceId: isSelected ? null : state.expandedWorkspaceId,
        expandedProjectId: isSelected ? null : state.expandedProjectId,
      };
    });
  },

  addProject: async (workspaceName, path) => {
    const project = await workspaceService.addWorkspaceProject(workspaceName, path);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName
          ? { ...ws, projects: mergeWorkspaceProject(ws.projects, project) }
          : ws
      ),
    }));
    return project;
  },

  addSshProject: async (workspaceName, sshInfo) => {
    const project = await workspaceService.addSshProject(workspaceName, sshInfo);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName
          ? { ...ws, projects: mergeWorkspaceProject(ws.projects, project) }
          : ws
      ),
    }));
    return project;
  },

  removeProject: async (workspaceName, projectId) => {
    await workspaceService.removeWorkspaceProject(workspaceName, projectId);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName
          ? { ...ws, projects: ws.projects.filter((p) => p.id !== projectId) }
          : ws
      ),
      expandedProjectId:
        state.expandedProjectId === projectId ? null : state.expandedProjectId,
    }));
  },

  updateProjectAlias: async (workspaceName, projectId, alias) => {
    await workspaceService.updateWorkspaceProjectAlias(workspaceName, projectId, alias);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName
          ? {
              ...ws,
              projects: ws.projects.map((p) =>
                p.id === projectId ? { ...p, alias: alias ?? undefined } : p
              ),
            }
          : ws
      ),
    }));
  },

  updateWorkspaceAlias: async (workspaceName, alias) => {
    await workspaceService.updateWorkspaceAlias(workspaceName, alias);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName ? { ...ws, alias: alias ?? undefined } : ws
      ),
    }));
  },

  updateWorkspaceProvider: async (workspaceName, providerId) => {
    await workspaceService.updateWorkspaceProvider(workspaceName, providerId);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName
          ? { ...ws, providerId: providerId ?? undefined }
          : ws
      ),
    }));
  },

  updateWorkspaceLaunchProfile: async (workspaceName, launchProfileId) => {
    await workspaceService.updateWorkspaceLaunchProfile(workspaceName, launchProfileId);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName
          ? { ...ws, launchProfileId: launchProfileId ?? undefined }
          : ws
      ),
    }));
  },

  updateWorkspacePath: async (workspaceName, path) => {
    await workspaceService.updateWorkspacePath(workspaceName, path);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName ? { ...ws, path: path ?? undefined } : ws
      ),
    }));
  },

  refreshWorkspace: async (workspaceId) => {
    let workspace = get().workspaces.find((ws) => ws.id === workspaceId);
    if (!workspace) {
      await get().load();
      workspace = get().workspaces.find((ws) => ws.id === workspaceId);
    }
    if (!workspace) return undefined;

    const refreshed = await workspaceService.getWorkspace(workspace.name);
    set((state) => ({ workspaces: mergeWorkspace(state.workspaces, refreshed) }));
    return refreshed;
  },

  saveWorkspace: async (workspace) => {
    await workspaceService.saveWorkspace(workspace.name, workspace);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspace.name ? workspace : ws
      ),
    }));
  },

  updatePinned: async (name, pinned) => {
    await workspaceService.updateWorkspacePinned(name, pinned);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === name ? { ...ws, pinned } : ws
      ),
    }));
  },

  updateHidden: async (name, hidden) => {
    await workspaceService.updateWorkspaceHidden(name, hidden);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === name ? { ...ws, hidden } : ws
      ),
    }));
  },

  setArchived: async (name, archived) => {
    await workspaceService.setWorkspaceArchived(name, archived);
    // 后端写的是服务端时间戳，本地只需要区分"有/无"，回填一个占位值即可；
    // 下一次 load() 会取回真实值。
    const archivedAt = archived ? new Date().toISOString() : null;
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === name ? { ...ws, archivedAt } : ws
      ),
    }));
  },

  setProjectArchived: async (workspaceName, projectId, archived) => {
    await workspaceService.setWorkspaceProjectArchived(
      workspaceName,
      projectId,
      archived
    );
    const archivedAt = archived ? new Date().toISOString() : null;
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName
          ? {
              ...ws,
              projects: ws.projects.map((project) =>
                project.id === projectId ? { ...project, archivedAt } : project
              ),
            }
          : ws
      ),
    }));
  },

  reorder: async (orderedNames) => {
    const previousWorkspaces = get().workspaces;
    set({
      workspaces: reorderWorkspaceList(previousWorkspaces, orderedNames),
    });
    try {
      await workspaceService.reorderWorkspaces(orderedNames);
    } catch (error) {
      set({ workspaces: previousWorkspaces });
      throw error;
    }
  },

  expandWorkspace: (id) => {
    set((state) => ({
      expandedWorkspaceId: state.expandedWorkspaceId === id ? null : id,
      expandedProjectId:
        state.expandedWorkspaceId === id ? null : state.expandedProjectId,
    }));
  },

  expandProject: (id) => {
    set((state) => ({
      expandedProjectId: state.expandedProjectId === id ? null : id,
    }));
  },
}));
