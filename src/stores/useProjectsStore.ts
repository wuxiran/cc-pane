import { create } from "zustand";
import { projectService } from "@/services";
import type { Project } from "@/types";
import { translateError } from "@/utils";

interface ProjectsState {
  projects: Project[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  selectedProject: () => Project | undefined;
  load: () => Promise<void>;
  add: (path: string) => Promise<Project>;
  remove: (id: string) => Promise<void>;
  select: (id: string) => void;
  updateName: (id: string, name: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  selectedId: null,
  loading: false,
  error: null,

  selectedProject: () => {
    const { projects, selectedId } = get();
    return projects.find((p) => p.id === selectedId);
  },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await projectService.list();
      const selectedId = get().selectedId;
      set({
        projects,
        selectedId:
          projects.length > 0 && !selectedId ? projects[0].id : selectedId,
      });
    } catch (e) {
      set({ error: translateError(e) });
      throw e;
    } finally {
      set({ loading: false });
    }
  },

  add: async (path) => {
    const project = await projectService.add(path);
    set((state) => ({
      projects: [...state.projects, project],
      selectedId: project.id,
    }));
    return project;
  },

  remove: async (id) => {
    await projectService.remove(id);
    set((state) => {
      const projects = state.projects.filter((p) => p.id !== id);
      return {
        projects,
        selectedId:
          state.selectedId === id ? projects[0]?.id || null : state.selectedId,
      };
    });
  },

  select: (id) => set({ selectedId: id }),

  updateName: async (id, name) => {
    await projectService.updateName(id, name);
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, name } : p
      ),
    }));
  },
}));
