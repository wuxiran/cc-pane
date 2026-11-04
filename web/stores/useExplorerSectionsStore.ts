// Explorer 侧栏激活视图（工作区 / 最近启动 / Agent 会话 单选，纯 UI 偏好，持久化到 localStorage）
// 文件 / Git 已迁往 RightDock，旧持久化值需迁移回 workspaces
// v3 起加「简洁模式」：一个列表合并终端会话与 Agent 对话、按项目挂载；
// 置顶与默认上下文工作空间都只是前端偏好，不动后端 workspace.json。
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ExplorerSectionId = "workspaces" | "sessions" | "agentChats";
export type WorkspaceTreeMode = "projects" | "terminals";
export type ExplorerMode = "full" | "simple";

const SECTION_IDS: readonly ExplorerSectionId[] = ["workspaces", "sessions", "agentChats"];
const TREE_MODES: readonly WorkspaceTreeMode[] = ["projects", "terminals"];
const EXPLORER_MODES: readonly ExplorerMode[] = ["full", "simple"];

interface ExplorerSectionsState {
  activeSection: ExplorerSectionId;
  /** 工作空间树的展示模式：项目列表 / 运行中的终端 */
  workspaceTreeMode: WorkspaceTreeMode;
  /** 完整（三 tab）/ 简洁（单列表） */
  explorerMode: ExplorerMode;
  /** 简洁模式下「启动终端 / 新聊天」无选中项目时的上下文工作空间名；空则取首个用户工作空间 */
  preferredContextWorkspaceName: string | null;
  /** 置顶会话 key（`launch:<id>` / `chat:<acpSessionId>`），按置顶顺序 */
  pinnedSessionKeys: string[];
  /** 简洁模式里折叠起来的项目路径 */
  collapsedSimpleProjects: string[];
  setActiveSection: (id: ExplorerSectionId) => void;
  setWorkspaceTreeMode: (mode: WorkspaceTreeMode) => void;
  setExplorerMode: (mode: ExplorerMode) => void;
  setPreferredContextWorkspace: (name: string | null) => void;
  togglePinnedSession: (key: string) => void;
  toggleSimpleProject: (path: string) => void;
}

function toggleIn(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export const useExplorerSectionsStore = create<ExplorerSectionsState>()(
  persist(
    (set) => ({
      activeSection: "workspaces",
      workspaceTreeMode: "projects",
      explorerMode: "full",
      preferredContextWorkspaceName: null,
      pinnedSessionKeys: [],
      collapsedSimpleProjects: [],
      setActiveSection: (id) => set({ activeSection: id }),
      setWorkspaceTreeMode: (mode) => set({ workspaceTreeMode: mode }),
      setExplorerMode: (mode) => set({ explorerMode: mode }),
      setPreferredContextWorkspace: (name) => set({ preferredContextWorkspaceName: name }),
      togglePinnedSession: (key) =>
        set((state) => ({ pinnedSessionKeys: toggleIn(state.pinnedSessionKeys, key) })),
      toggleSimpleProject: (path) =>
        set((state) => ({ collapsedSimpleProjects: toggleIn(state.collapsedSimpleProjects, path) })),
    }),
    {
      name: "cc-panes-explorer-sections",
      version: 3,
      partialize: (s) => ({
        activeSection: s.activeSection,
        workspaceTreeMode: s.workspaceTreeMode,
        explorerMode: s.explorerMode,
        preferredContextWorkspaceName: s.preferredContextWorkspaceName,
        pinnedSessionKeys: s.pinnedSessionKeys,
        collapsedSimpleProjects: s.collapsedSimpleProjects,
      }),
      // v0 可能持久化了已下线的 files/git，落回 workspaces；v1 → v2 补 workspaceTreeMode；v2 → v3 补简洁模式字段
      migrate: (persisted) => {
        const state = persisted as Partial<ExplorerSectionsState> | undefined;
        const active = state?.activeSection;
        const mode = state?.workspaceTreeMode;
        const explorerMode = state?.explorerMode;
        const preferred = state?.preferredContextWorkspaceName;
        return {
          activeSection: active && SECTION_IDS.includes(active) ? active : "workspaces",
          workspaceTreeMode: mode && TREE_MODES.includes(mode) ? mode : "projects",
          explorerMode: explorerMode && EXPLORER_MODES.includes(explorerMode) ? explorerMode : "full",
          preferredContextWorkspaceName: typeof preferred === "string" ? preferred : null,
          pinnedSessionKeys: stringList(state?.pinnedSessionKeys),
          collapsedSimpleProjects: stringList(state?.collapsedSimpleProjects),
        } as ExplorerSectionsState;
      },
    },
  ),
);
