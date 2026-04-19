import { create } from "zustand";
import type { Workspace, WorkspaceProject, SshConnectionInfo } from "@/types";
import * as workspaceService from "@/services/workspaceService";
import { detectAppPlatform } from "@/utils";

interface WorkspacesState {
  workspaces: Workspace[];
  expandedWorkspaceId: string | null;
  expandedProjectId: string | null;
  loading: boolean;
  selectedWorkspace: () => Workspace | undefined;
  selectedProject: () => WorkspaceProject | null;
  pinnedWorkspaces: () => Workspace[];
  unpinnedVisibleWorkspaces: () => Workspace[];
  hiddenWorkspaces: () => Workspace[];
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
  updateWorkspacePath: (workspaceName: string, path: string | null) => Promise<void>;
  saveWorkspace: (workspace: Workspace) => Promise<void>;
  updatePinned: (name: string, pinned: boolean) => Promise<void>;
  updateHidden: (name: string, hidden: boolean) => Promise<void>;
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

  load: async () => {
    set({ loading: true });
    try {
      const workspaces = await workspaceService.listWorkspaces();
      set({ workspaces });
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

  updateWorkspacePath: async (workspaceName, path) => {
    await workspaceService.updateWorkspacePath(workspaceName, path);
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.name === workspaceName ? { ...ws, path: path ?? undefined } : ws
      ),
    }));
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
