// Explorer 侧栏激活视图（工作区 / 最近启动 双按钮单选，纯 UI 偏好，持久化到 localStorage）
// 文件 / Git 已迁往 RightDock，旧持久化值需迁移回 workspaces
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ExplorerSectionId = "workspaces" | "sessions";

const SECTION_IDS: readonly ExplorerSectionId[] = ["workspaces", "sessions"];

interface ExplorerSectionsState {
  activeSection: ExplorerSectionId;
  setActiveSection: (id: ExplorerSectionId) => void;
}

export const useExplorerSectionsStore = create<ExplorerSectionsState>()(
  persist(
    (set) => ({
      activeSection: "workspaces",
      setActiveSection: (id) => set({ activeSection: id }),
    }),
    {
      name: "cc-panes-explorer-sections",
      version: 1,
      partialize: (s) => ({ activeSection: s.activeSection }),
      // v0 可能持久化了已下线的 files/git，落回 workspaces
      migrate: (persisted) => {
        const state = persisted as Partial<ExplorerSectionsState> | undefined;
        const active = state?.activeSection;
        return {
          activeSection: active && SECTION_IDS.includes(active) ? active : "workspaces",
        } as ExplorerSectionsState;
      },
    },
  ),
);
