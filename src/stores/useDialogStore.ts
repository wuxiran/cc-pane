import { create } from "zustand";

interface DialogState {
  // Settings
  settingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;

  // Journal
  journalOpen: boolean;
  journalWorkspaceName: string;
  openJournal: (workspaceName: string) => void;
  closeJournal: () => void;

  // Local History
  localHistoryOpen: boolean;
  localHistoryProjectPath: string;
  openLocalHistory: (projectPath: string) => void;
  closeLocalHistory: () => void;

  // Session Cleaner
  sessionCleanerOpen: boolean;
  sessionCleanerProjectPath: string;
  openSessionCleaner: (projectPath: string) => void;
  closeSessionCleaner: () => void;
}

export const useDialogStore = create<DialogState>((set) => ({
  // Settings
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),

  // Journal
  journalOpen: false,
  journalWorkspaceName: "",
  openJournal: (workspaceName) => set({ journalOpen: true, journalWorkspaceName: workspaceName }),
  closeJournal: () => set({ journalOpen: false }),

  // Local History
  localHistoryOpen: false,
  localHistoryProjectPath: "",
  openLocalHistory: (projectPath) => set({ localHistoryOpen: true, localHistoryProjectPath: projectPath }),
  closeLocalHistory: () => set({ localHistoryOpen: false }),

  // Session Cleaner
  sessionCleanerOpen: false,
  sessionCleanerProjectPath: "",
  openSessionCleaner: (projectPath) => set({ sessionCleanerOpen: true, sessionCleanerProjectPath: projectPath }),
  closeSessionCleaner: () => set({ sessionCleanerOpen: false }),
}));
