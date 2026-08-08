import { create } from "zustand";

interface SshMachineDialogState {
  addDialogOpen: boolean;
  openAddDialog: () => void;
  closeAddDialog: () => void;
}

export const useSshMachineDialogStore = create<SshMachineDialogState>((set) => ({
  addDialogOpen: false,
  openAddDialog: () => set({ addDialogOpen: true }),
  closeAddDialog: () => set({ addDialogOpen: false }),
}));
