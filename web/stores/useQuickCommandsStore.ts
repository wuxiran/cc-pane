// 快捷命令三层：global（用户）/ workspace（工作空间，workspace-first 默认层）/ project（仓库覆盖）。
// 展示顺序 global → workspace → project；project 与 workspace 层是整文件读写。
import { create } from "zustand";
import { quickCommandService } from "@/services/quickCommandService";
import type {
  QuickCommand,
  QuickCommandDraft,
  QuickCommandScope,
  ScopedQuickCommand,
} from "@/types";

export interface QuickCommandContext {
  projectPath?: string;
  workspaceName?: string;
}

interface QuickCommandsState {
  globalCommands: QuickCommand[];
  workspaceCommands: QuickCommand[];
  projectCommands: QuickCommand[];
  commands: ScopedQuickCommand[];
  activeProjectPath: string | null;
  activeWorkspaceName: string | null;
  loading: boolean;
  load: (context?: QuickCommandContext | string) => Promise<void>;
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
  workspaceCommands: QuickCommand[],
  projectCommands: QuickCommand[],
): ScopedQuickCommand[] {
  return [
    ...globalCommands.map((command) => ({ ...command, scope: "global" as const })),
    ...workspaceCommands.map((command) => ({ ...command, scope: "workspace" as const })),
    ...projectCommands.map((command) => ({ ...command, scope: "project" as const })),
  ];
}

/**
 * 只保留对当前上下文有效的命令：global 永远在；workspace 层要求上下文工作空间与已加载的一致；
 * project 层要求上下文项目与已加载的一致。
 */
export function filterQuickCommandsForProject(
  commands: ScopedQuickCommand[],
  loadedProjectPath: string | null,
  contextProjectPath?: string,
  loadedWorkspaceName: string | null = null,
  contextWorkspaceName?: string,
): ScopedQuickCommand[] {
  const includeProject = Boolean(contextProjectPath && contextProjectPath === loadedProjectPath);
  const includeWorkspace = Boolean(
    contextWorkspaceName && contextWorkspaceName === loadedWorkspaceName,
  );
  return commands.filter((command) => {
    if (command.scope === "global") return true;
    if (command.scope === "workspace") return includeWorkspace;
    return includeProject;
  });
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

function requireWorkspaceName(activeName: string | null): string {
  if (!activeName) {
    throw new Error("Workspace quick commands require an active workspace");
  }
  return activeName;
}

function normalizeContext(context?: QuickCommandContext | string): QuickCommandContext {
  if (typeof context === "string") return { projectPath: context };
  return context ?? {};
}

let latestLoad = 0;

export const useQuickCommandsStore = create<QuickCommandsState>((set, get) => {
  const commit = (layers: Partial<Pick<QuickCommandsState, "globalCommands" | "workspaceCommands" | "projectCommands">>) => {
    const next = { ...get(), ...layers };
    set({
      ...layers,
      commands: mergeCommands(next.globalCommands, next.workspaceCommands, next.projectCommands),
    });
  };

  /** 对 workspace / project 这两个整文件层做一次「读改写」 */
  const saveLayer = async (
    scope: Exclude<QuickCommandScope, "global">,
    projectPath: string | undefined,
    transform: (current: QuickCommand[]) => QuickCommand[],
  ): Promise<void> => {
    if (scope === "project") {
      const path = requireProjectPath(projectPath, get().activeProjectPath);
      const projectCommands = await quickCommandService.saveProject(path, transform(get().projectCommands));
      set({ activeProjectPath: path });
      commit({ projectCommands });
      return;
    }
    const name = requireWorkspaceName(get().activeWorkspaceName);
    const workspaceCommands = await quickCommandService.saveWorkspace(name, transform(get().workspaceCommands));
    commit({ workspaceCommands });
  };

  return {
    globalCommands: [],
    workspaceCommands: [],
    projectCommands: [],
    commands: [],
    activeProjectPath: null,
    activeWorkspaceName: null,
    loading: false,

    async load(contextInput) {
      const { projectPath, workspaceName } = normalizeContext(contextInput);
      const requestId = ++latestLoad;
      set((state) => ({
        activeProjectPath: projectPath ?? null,
        activeWorkspaceName: workspaceName ?? null,
        projectCommands: [],
        workspaceCommands: [],
        commands: mergeCommands(state.globalCommands, [], []),
        loading: true,
      }));
      try {
        const [globalCommands, workspaceCommands, projectCommands] = await Promise.all([
          quickCommandService.listGlobal(),
          workspaceName ? quickCommandService.listWorkspace(workspaceName) : Promise.resolve([]),
          projectPath ? quickCommandService.listProject(projectPath) : Promise.resolve([]),
        ]);
        if (requestId !== latestLoad) return;
        set({
          globalCommands,
          workspaceCommands,
          projectCommands,
          commands: mergeCommands(globalCommands, workspaceCommands, projectCommands),
          activeProjectPath: projectPath ?? null,
          activeWorkspaceName: workspaceName ?? null,
        });
      } finally {
        if (requestId === latestLoad) set({ loading: false });
      }
    },

    async create(draft, scope, projectPath) {
      const normalized = normalizeDraft(draft);
      if (scope === "global") {
        const created = await quickCommandService.createGlobal(normalized);
        commit({ globalCommands: [...get().globalCommands, created] });
        return { ...created, scope };
      }
      const now = new Date().toISOString();
      const created: QuickCommand = { ...normalized, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
      await saveLayer(scope, projectPath, (current) => [...current, created]);
      return { ...created, scope };
    },

    async update(id, draft, scope, projectPath) {
      const normalized = normalizeDraft(draft);
      if (scope === "global") {
        const updated = await quickCommandService.updateGlobal(id, normalized);
        commit({
          globalCommands: get().globalCommands.map((command) => (command.id === id ? updated : command)),
        });
        return { ...updated, scope };
      }
      const layer = scope === "project" ? get().projectCommands : get().workspaceCommands;
      const existing = layer.find((command) => command.id === id);
      if (!existing) throw new Error(`Quick command '${id}' not found`);
      const updated: QuickCommand = { ...existing, ...normalized, id, updatedAt: new Date().toISOString() };
      await saveLayer(scope, projectPath, (current) =>
        current.map((command) => (command.id === id ? updated : command)),
      );
      return { ...updated, scope };
    },

    async remove(id, scope, projectPath) {
      if (scope === "global") {
        await quickCommandService.deleteGlobal(id);
        commit({ globalCommands: get().globalCommands.filter((command) => command.id !== id) });
        return;
      }
      await saveLayer(scope, projectPath, (current) => current.filter((command) => command.id !== id));
    },
  };
});
