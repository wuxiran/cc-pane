import { create } from "zustand";

interface PendingLaunch {
  path: string;
  workspaceName?: string;
  providerId: string;
  workspacePath?: string;
}

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
  localHistoryFilePath: string;
  openLocalHistory: (projectPath: string, filePath?: string) => void;
  closeLocalHistory: () => void;

  // Session Cleaner
  sessionCleanerOpen: boolean;
  sessionCleanerProjectPath: string;
  openSessionCleaner: (projectPath: string) => void;
  closeSessionCleaner: () => void;

  // Todo
  todoOpen: boolean;
  todoScope: string;
  todoScopeRef: string;
  openTodo: (scope: string, scopeRef: string) => void;
  closeTodo: () => void;

  // Plans
  plansOpen: boolean;
  plansProjectPath: string;
  openPlans: (projectPath: string) => void;
  closePlans: () => void;

  // Self Chat
  selfChatOpen: boolean;
  openSelfChat: () => void;
  closeSelfChat: () => void;

  // Onboarding
  onboardingOpen: boolean;
  openOnboarding: () => void;
  closeOnboarding: () => void;

  // Pending Launch（Settings → App 跨组件启动传递）
  pendingLaunch: PendingLaunch | null;
  setPendingLaunch: (launch: PendingLaunch) => void;
  clearPendingLaunch: () => void;
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
  localHistoryFilePath: "",
  openLocalHistory: (projectPath, filePath) =>
    set({ localHistoryOpen: true, localHistoryProjectPath: projectPath, localHistoryFilePath: filePath || "" }),
  closeLocalHistory: () => set({ localHistoryOpen: false, localHistoryFilePath: "" }),

  // Session Cleaner
  sessionCleanerOpen: false,
  sessionCleanerProjectPath: "",
  openSessionCleaner: (projectPath) => set({ sessionCleanerOpen: true, sessionCleanerProjectPath: projectPath }),
  closeSessionCleaner: () => set({ sessionCleanerOpen: false }),

  // Todo
  todoOpen: false,
  todoScope: "",
  todoScopeRef: "",
  openTodo: (scope, scopeRef) => set({ todoOpen: true, todoScope: scope, todoScopeRef: scopeRef }),
  closeTodo: () => set({ todoOpen: false }),

  // Plans
  plansOpen: false,
  plansProjectPath: "",
  openPlans: (projectPath) => set({ plansOpen: true, plansProjectPath: projectPath }),
  closePlans: () => set({ plansOpen: false }),

  // Self Chat
  selfChatOpen: false,
  openSelfChat: () => set({ selfChatOpen: true }),
  closeSelfChat: () => set({ selfChatOpen: false }),

  // Onboarding
  onboardingOpen: false,
  openOnboarding: () => set({ onboardingOpen: true }),
  closeOnboarding: () => set({ onboardingOpen: false }),

  // Pending Launch
  pendingLaunch: null,
  setPendingLaunch: (launch) => set({ pendingLaunch: launch }),
  clearPendingLaunch: () => set({ pendingLaunch: null }),
}));
