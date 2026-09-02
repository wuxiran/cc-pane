import { create } from "zustand";
import { persist } from "zustand/middleware";

export const SSH_MACHINE_PREFERENCES_STORAGE_KEY =
  "cc-panes-ssh-machine-preferences";

interface SshMachinePreferencesState {
  favoriteMachineIds: string[];
  selectedMachineId: string | null;
  toggleFavorite: (machineId: string) => void;
  selectMachine: (machineId: string | null) => void;
}

/** Connection and credential data remain in the SSH machine service. */
export const useSshMachinePreferencesStore =
  create<SshMachinePreferencesState>()(
    persist(
      (set) => ({
        favoriteMachineIds: [],
        selectedMachineId: null,
        toggleFavorite: (machineId) =>
          set((state) => ({
            favoriteMachineIds: state.favoriteMachineIds.includes(machineId)
              ? state.favoriteMachineIds.filter((id) => id !== machineId)
              : [...state.favoriteMachineIds, machineId],
          })),
        selectMachine: (selectedMachineId) => set({ selectedMachineId }),
      }),
      {
        name: SSH_MACHINE_PREFERENCES_STORAGE_KEY,
        partialize: (state) => ({
          favoriteMachineIds: state.favoriteMachineIds,
          selectedMachineId: state.selectedMachineId,
        }),
      },
    ),
  );
