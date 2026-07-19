// Explorer 侧栏激活视图（工作区 / 文件 / Git / 最近启动 四按钮单选，纯 UI 偏好，持久化到 localStorage）
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ExplorerSectionId = "workspaces" | "files" | "git" | "sessions";

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
      partialize: (s) => ({ activeSection: s.activeSection }),
    },
  ),
);
