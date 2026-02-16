import { create } from "zustand";
import type { Workspace, WorkspaceProject } from "@/types";
import * as workspaceService from "@/services/workspaceService";

interface WorkspacesState {
  workspaces: Workspace[];
  expandedWorkspaceId: string | null;
  expandedProjectId: string | null;
  loading: boolean;
  selectedWorkspace: () => Workspace | undefined;
  selectedProject: () => WorkspaceProject | null;
  load: () => Promise<void>;
  create: (name: string) => Promise<Workspace>;
  rename: (oldName: string, newName: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  addProject: (workspaceName: string, path: string) => Promise<WorkspaceProject>;
  removeProject: (workspaceName: string, projectId: string) => Promise<void>;
  updateProjectAlias: (workspaceName: string, projectId: string, alias: string | null) => Promise<void>;
  updateWorkspaceAlias: (workspaceName: string, alias: string | null) => Promise<void>;
  updateWorkspaceProvider: (workspaceName: string, providerId: string | null) => Promise<void>;
  expandWorkspace: (id: string | null) => void;
  expandProject: (id: string | null) => void;
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

  load: async () => {
    set({ loading: true });
    try {
      const workspaces = await workspaceService.listWorkspaces();
      set({ workspaces });
    } finally {
      set({ loading: false });
    }
  },

  create: async (name) => {
    const ws = await workspaceService.createWorkspace(name);
    set((state) => ({ workspaces: [...state.workspaces, ws] }));
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
          ? { ...ws, projects: [...ws.projects, project] }
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
          ? { ...ws, provider_id: providerId ?? undefined }
          : ws
      ),
    }));
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
