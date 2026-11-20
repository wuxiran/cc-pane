// Explorer 侧栏激活视图（工作区 / 最近启动 / Agent 会话 单选，纯 UI 偏好，持久化到 localStorage）
// 文件 / Git 已迁往 RightDock，旧持久化值需迁移回 workspaces
// v4：资源管理器只留一种模式（原「简洁 / 完整」的切换下线）；「工作空间」分区头可折叠。
// 默认上下文工作空间只是前端偏好，不动后端 workspace.json。
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ExplorerSectionId = "workspaces" | "sessions" | "agentChats" | "bots";
export type WorkspaceTreeMode = "projects" | "terminals";

const SECTION_IDS: readonly ExplorerSectionId[] = ["workspaces", "sessions", "agentChats", "bots"];
const TREE_MODES: readonly WorkspaceTreeMode[] = ["projects", "terminals"];

interface ExplorerSectionsState {
  activeSection: ExplorerSectionId;
  /** 工作空间树的展示模式：项目列表 / 运行中的终端 */
  workspaceTreeMode: WorkspaceTreeMode;
  /** 「工作空间」分区是否收起（点分区头切换） */
  workspacesCollapsed: boolean;
  /** 无选中项目时「启动终端 / 新聊天」的上下文工作空间名；空则取首个用户工作空间 */
  preferredContextWorkspaceName: string | null;
  setActiveSection: (id: ExplorerSectionId) => void;
  setWorkspaceTreeMode: (mode: WorkspaceTreeMode) => void;
  toggleWorkspacesCollapsed: () => void;
  setPreferredContextWorkspace: (name: string | null) => void;
}

export const useExplorerSectionsStore = create<ExplorerSectionsState>()(
  persist(
    (set) => ({
      activeSection: "workspaces",
      workspaceTreeMode: "projects",
      workspacesCollapsed: false,
      preferredContextWorkspaceName: null,
      setActiveSection: (id) => set({ activeSection: id }),
      setWorkspaceTreeMode: (mode) => set({ workspaceTreeMode: mode }),
      toggleWorkspacesCollapsed: () => set((state) => ({ workspacesCollapsed: !state.workspacesCollapsed })),
      setPreferredContextWorkspace: (name) => set({ preferredContextWorkspaceName: name }),
    }),
    {
      name: "cc-panes-explorer-sections",
      version: 4,
      partialize: (s) => ({
        activeSection: s.activeSection,
        workspaceTreeMode: s.workspaceTreeMode,
        workspacesCollapsed: s.workspacesCollapsed,
        preferredContextWorkspaceName: s.preferredContextWorkspaceName,
      }),
      // v0 可能持久化了已下线的 files/git，落回 workspaces；v1 → v2 补 workspaceTreeMode；
      // v3 → v4 丢掉简洁模式的字段（explorerMode / pinnedSessionKeys / collapsedSimpleProjects）
      migrate: (persisted) => {
        const state = persisted as Partial<ExplorerSectionsState> | undefined;
        const active = state?.activeSection;
        const mode = state?.workspaceTreeMode;
        const preferred = state?.preferredContextWorkspaceName;
        return {
          activeSection: active && SECTION_IDS.includes(active) ? active : "workspaces",
          workspaceTreeMode: mode && TREE_MODES.includes(mode) ? mode : "projects",
          workspacesCollapsed: state?.workspacesCollapsed === true,
          preferredContextWorkspaceName: typeof preferred === "string" ? preferred : null,
        } as ExplorerSectionsState;
      },
    },
  ),
);
