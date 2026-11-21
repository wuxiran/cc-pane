// 首页「新建工作空间 / 导入项目」弹框的开关：快速上手、最近项目空态等多处入口共用，弹框本体挂在 HomeDashboard。
import { create } from "zustand";

export type HomeSetupDialogMode = "workspace" | "project";

interface HomeSetupDialogState {
  mode: HomeSetupDialogMode | null;
  /** 导入项目时预选的工作空间（刚新建的那个）。 */
  workspaceId: string | null;
  open: (mode: HomeSetupDialogMode, workspaceId?: string | null) => void;
  close: () => void;
}

export const useHomeSetupDialogStore = create<HomeSetupDialogState>((set) => ({
  mode: null,
  workspaceId: null,
  open: (mode, workspaceId = null) => set({ mode, workspaceId }),
  close: () => set({ mode: null, workspaceId: null }),
}));

export const openHomeCreateWorkspace = () => useHomeSetupDialogStore.getState().open("workspace");
export const openHomeImportProject = (workspaceId?: string | null) =>
  useHomeSetupDialogStore.getState().open("project", workspaceId);
