// Explorer 侧栏的 UI 偏好（持久化到 localStorage）。
// v6：侧栏不再分视图（会话进了搜索面板、通讯录进了左侧图标栏），activeSection 下线。
// v7：加「最近」分区的收起状态。
// v8：加 explorerMode（工作空间树 / 任务面板）。
// 默认上下文工作空间只是前端偏好，不动后端 workspace.json。
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WorkspaceTreeMode = "projects" | "terminals";
/** 侧栏主视图：工作空间树（+ 最近）/ 跨工作空间的任务面板 */
export type ExplorerMode = "workspaces" | "tasks";

const TREE_MODES: readonly WorkspaceTreeMode[] = ["projects", "terminals"];
const EXPLORER_MODES: readonly ExplorerMode[] = ["workspaces", "tasks"];

interface ExplorerSectionsState {
  explorerMode: ExplorerMode;
  /** 工作空间树的展示模式：项目列表 / 运行中的终端 */
  workspaceTreeMode: WorkspaceTreeMode;
  /** 「工作空间」分区是否收起（点分区头切换） */
  workspacesCollapsed: boolean;
  /** 「最近」分区（最近的会话）是否收起 */
  recentCollapsed: boolean;
  /** 无选中项目时「启动终端 / 新聊天」的上下文工作空间名；空则取首个用户工作空间 */
  preferredContextWorkspaceName: string | null;
  setWorkspaceTreeMode: (mode: WorkspaceTreeMode) => void;
  setExplorerMode: (mode: ExplorerMode) => void;
  toggleWorkspacesCollapsed: () => void;
  toggleRecentCollapsed: () => void;
  setPreferredContextWorkspace: (name: string | null) => void;
}

export const useExplorerSectionsStore = create<ExplorerSectionsState>()(
  persist(
    (set) => ({
      explorerMode: "workspaces",
      workspaceTreeMode: "projects",
      workspacesCollapsed: false,
      recentCollapsed: false,
      preferredContextWorkspaceName: null,
      setWorkspaceTreeMode: (mode) => set({ workspaceTreeMode: mode }),
      setExplorerMode: (mode) => set({ explorerMode: mode }),
      toggleWorkspacesCollapsed: () => set((state) => ({ workspacesCollapsed: !state.workspacesCollapsed })),
      toggleRecentCollapsed: () => set((state) => ({ recentCollapsed: !state.recentCollapsed })),
      setPreferredContextWorkspace: (name) => set({ preferredContextWorkspaceName: name }),
    }),
    {
      name: "cc-panes-explorer-sections",
      version: 8,
      partialize: (s) => ({
        explorerMode: s.explorerMode,
        workspaceTreeMode: s.workspaceTreeMode,
        workspacesCollapsed: s.workspacesCollapsed,
        recentCollapsed: s.recentCollapsed,
        preferredContextWorkspaceName: s.preferredContextWorkspaceName,
      }),
      // v0 可能持久化了已下线的 files/git，落回 workspaces；v1 → v2 补 workspaceTreeMode；
      // v3 → v4 丢掉简洁模式的字段（explorerMode / pinnedSessionKeys / collapsedSimpleProjects）
      migrate: (persisted) => {
        const state = persisted as Partial<ExplorerSectionsState> | undefined;
        const mode = state?.workspaceTreeMode;
        // v3 简洁模式也叫 explorerMode（值域不同），白名单校验即可滤掉
        const explorerMode = state?.explorerMode;
        const preferred = state?.preferredContextWorkspaceName;
        return {
          explorerMode: explorerMode && EXPLORER_MODES.includes(explorerMode) ? explorerMode : "workspaces",
          workspaceTreeMode: mode && TREE_MODES.includes(mode) ? mode : "projects",
          workspacesCollapsed: state?.workspacesCollapsed === true,
          recentCollapsed: state?.recentCollapsed === true,
          preferredContextWorkspaceName: typeof preferred === "string" ? preferred : null,
        } as ExplorerSectionsState;
      },
    },
  ),
);
