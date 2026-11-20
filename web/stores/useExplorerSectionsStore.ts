// Explorer 侧栏的 UI 偏好（持久化到 localStorage）。
// v6：侧栏不再分视图（会话进了搜索面板、通讯录进了左侧图标栏），activeSection 下线。
// 默认上下文工作空间只是前端偏好，不动后端 workspace.json。
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type WorkspaceTreeMode = "projects" | "terminals";

const TREE_MODES: readonly WorkspaceTreeMode[] = ["projects", "terminals"];

interface ExplorerSectionsState {
  /** 工作空间树的展示模式：项目列表 / 运行中的终端 */
  workspaceTreeMode: WorkspaceTreeMode;
  /** 「工作空间」分区是否收起（点分区头切换） */
  workspacesCollapsed: boolean;
  /** 无选中项目时「启动终端 / 新聊天」的上下文工作空间名；空则取首个用户工作空间 */
  preferredContextWorkspaceName: string | null;
  setWorkspaceTreeMode: (mode: WorkspaceTreeMode) => void;
  toggleWorkspacesCollapsed: () => void;
  setPreferredContextWorkspace: (name: string | null) => void;
}

export const useExplorerSectionsStore = create<ExplorerSectionsState>()(
  persist(
    (set) => ({
      workspaceTreeMode: "projects",
      workspacesCollapsed: false,
      preferredContextWorkspaceName: null,
      setWorkspaceTreeMode: (mode) => set({ workspaceTreeMode: mode }),
      toggleWorkspacesCollapsed: () => set((state) => ({ workspacesCollapsed: !state.workspacesCollapsed })),
      setPreferredContextWorkspace: (name) => set({ preferredContextWorkspaceName: name }),
    }),
    {
      name: "cc-panes-explorer-sections",
      version: 6,
      partialize: (s) => ({
        workspaceTreeMode: s.workspaceTreeMode,
        workspacesCollapsed: s.workspacesCollapsed,
        preferredContextWorkspaceName: s.preferredContextWorkspaceName,
      }),
      // v0 可能持久化了已下线的 files/git，落回 workspaces；v1 → v2 补 workspaceTreeMode；
      // v3 → v4 丢掉简洁模式的字段（explorerMode / pinnedSessionKeys / collapsedSimpleProjects）
      migrate: (persisted) => {
        const state = persisted as Partial<ExplorerSectionsState> | undefined;
        const mode = state?.workspaceTreeMode;
        const preferred = state?.preferredContextWorkspaceName;
        return {
          workspaceTreeMode: mode && TREE_MODES.includes(mode) ? mode : "projects",
          workspacesCollapsed: state?.workspacesCollapsed === true,
          preferredContextWorkspaceName: typeof preferred === "string" ? preferred : null,
        } as ExplorerSectionsState;
      },
    },
  ),
);
