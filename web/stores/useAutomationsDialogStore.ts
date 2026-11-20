import { create } from "zustand";

/** 自动化（定时派工）独立弹窗的开关；入口在活动栏、布局栏与 Agent 会话列表。 */
interface AutomationsDialogState {
  open: boolean;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useAutomationsDialogStore = create<AutomationsDialogState>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  closeDialog: () => set({ open: false }),
}));

export function openAutomationsDialog(): void {
  useAutomationsDialogStore.getState().openDialog();
}
