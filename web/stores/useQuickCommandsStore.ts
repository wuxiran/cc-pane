import { create } from "zustand";
import { quickCommandService } from "@/services/quickCommandService";
import type {
  QuickCommand,
  QuickCommandDraft,
  QuickCommandScope,
  ScopedQuickCommand,
} from "@/types";

interface QuickCommandsState {
  globalCommands: QuickCommand[];
  projectCommands: QuickCommand[];
  commands: ScopedQuickCommand[];
  activeProjectPath: string | null;
  loading: boolean;
  load: (projectPath?: string) => Promise<void>;
  create: (
    draft: QuickCommandDraft,
    scope: QuickCommandScope,
    projectPath?: string,
  ) => Promise<ScopedQuickCommand>;
  update: (
    id: string,
    draft: QuickCommandDraft,
    scope: QuickCommandScope,
    projectPath?: string,
  ) => Promise<ScopedQuickCommand>;
  remove: (
    id: string,
    scope: QuickCommandScope,
    projectPath?: string,
  ) => Promise<void>;
}

function mergeCommands(
  globalCommands: QuickCommand[],
  projectCommands: QuickCommand[],
): ScopedQuickCommand[] {
  return [
    ...globalCommands.map((command) => ({ ...command, scope: "global" as const })),
    ...projectCommands.map((command) => ({ ...command, scope: "project" as const })),
  ];
}

function normalizeDraft(draft: QuickCommandDraft): QuickCommandDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    cliTool: draft.kind === "agentPrompt" ? draft.cliTool : undefined,
  };
}

function requireProjectPath(explicitPath: string | undefined, activePath: string | null): string {
  const projectPath = explicitPath ?? activePath;
  if (!projectPath) {
    throw new Error("Project quick commands require an active project");
  }
  return projectPath;
}

let latestLoad = 0;

export const useQuickCommandsStore = create<QuickCommandsState>((set, get) => ({
  globalCommands: [],
  projectCommands: [],
  commands: [],
  activeProjectPath: null,
  loading: false,

  async load(projectPath) {
    const requestId = ++latestLoad;
    set({ loading: true });
    try {
      const [globalCommands, projectCommands] = await Promise.all([
        quickCommandService.listGlobal(),
        projectPath ? quickCommandService.listProject(projectPath) : Promise.resolve([]),
      ]);
      if (requestId !== latestLoad) return;
      set({
        globalCommands,
        projectCommands,
        commands: mergeCommands(globalCommands, projectCommands),
        activeProjectPath: projectPath ?? null,
      });
    } finally {
      if (requestId === latestLoad) set({ loading: false });
    }
  },

  async create(draft, scope, projectPath) {
    const normalized = normalizeDraft(draft);
    if (scope === "global") {
      const created = await quickCommandService.createGlobal(normalized);
      const globalCommands = [...get().globalCommands, created];
      set({
        globalCommands,
        commands: mergeCommands(globalCommands, get().projectCommands),
      });
      return { ...created, scope };
    }

    const path = requireProjectPath(projectPath, get().activeProjectPath);
    const now = new Date().toISOString();
    const created: QuickCommand = {
      ...normalized,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    const projectCommands = await quickCommandService.saveProject(path, [
      ...get().projectCommands,
      created,
    ]);
    set({
      activeProjectPath: path,
      projectCommands,
      commands: mergeCommands(get().globalCommands, projectCommands),
    });
    return { ...created, scope };
  },

  async update(id, draft, scope, projectPath) {
    const normalized = normalizeDraft(draft);
    if (scope === "global") {
      const updated = await quickCommandService.updateGlobal(id, normalized);
      const globalCommands = get().globalCommands.map((command) =>
        command.id === id ? updated : command,
      );
      set({
        globalCommands,
        commands: mergeCommands(globalCommands, get().projectCommands),
      });
      return { ...updated, scope };
    }

    const path = requireProjectPath(projectPath, get().activeProjectPath);
    const existing = get().projectCommands.find((command) => command.id === id);
    if (!existing) throw new Error(`Quick command '${id}' not found`);
    const updated: QuickCommand = {
      ...existing,
      ...normalized,
      id,
      updatedAt: new Date().toISOString(),
    };
    const next = get().projectCommands.map((command) =>
      command.id === id ? updated : command,
    );
    const projectCommands = await quickCommandService.saveProject(path, next);
    set({
      activeProjectPath: path,
      projectCommands,
      commands: mergeCommands(get().globalCommands, projectCommands),
    });
    return { ...updated, scope };
  },

  async remove(id, scope, projectPath) {
    if (scope === "global") {
      await quickCommandService.deleteGlobal(id);
      const globalCommands = get().globalCommands.filter((command) => command.id !== id);
      set({
        globalCommands,
        commands: mergeCommands(globalCommands, get().projectCommands),
      });
      return;
    }

    const path = requireProjectPath(projectPath, get().activeProjectPath);
    const next = get().projectCommands.filter((command) => command.id !== id);
    const projectCommands = await quickCommandService.saveProject(path, next);
    set({
      activeProjectPath: path,
      projectCommands,
      commands: mergeCommands(get().globalCommands, projectCommands),
    });
  },
}));
