// Explorer 侧栏激活视图（工作区 / 最近启动 双按钮单选，纯 UI 偏好，持久化到 localStorage）
// 文件 / Git 已迁往 RightDock，旧持久化值需迁移回 workspaces
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ExplorerSectionId = "workspaces" | "sessions" | "agentChats";
export type WorkspaceTreeMode = "projects" | "terminals";

const SECTION_IDS: readonly ExplorerSectionId[] = ["workspaces", "sessions", "agentChats"];
const TREE_MODES: readonly WorkspaceTreeMode[] = ["projects", "terminals"];

interface ExplorerSectionsState {
  activeSection: ExplorerSectionId;
  /** 工作空间树的展示模式：项目列表 / 运行中的终端 */
  workspaceTreeMode: WorkspaceTreeMode;
  setActiveSection: (id: ExplorerSectionId) => void;
  setWorkspaceTreeMode: (mode: WorkspaceTreeMode) => void;
}

export const useExplorerSectionsStore = create<ExplorerSectionsState>()(
  persist(
    (set) => ({
      activeSection: "workspaces",
      workspaceTreeMode: "projects",
      setActiveSection: (id) => set({ activeSection: id }),
      setWorkspaceTreeMode: (mode) => set({ workspaceTreeMode: mode }),
    }),
    {
      name: "cc-panes-explorer-sections",
      version: 2,
      partialize: (s) => ({
        activeSection: s.activeSection,
        workspaceTreeMode: s.workspaceTreeMode,
      }),
      // v0 可能持久化了已下线的 files/git，落回 workspaces；v1 → v2 补 workspaceTreeMode
      migrate: (persisted) => {
        const state = persisted as Partial<ExplorerSectionsState> | undefined;
        const active = state?.activeSection;
        const mode = state?.workspaceTreeMode;
        return {
          activeSection: active && SECTION_IDS.includes(active) ? active : "workspaces",
          workspaceTreeMode: mode && TREE_MODES.includes(mode) ? mode : "projects",
        } as ExplorerSectionsState;
      },
    },
  ),
);
