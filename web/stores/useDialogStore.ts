import { create } from "zustand";
import type {
  CliTool,
  LaunchAdapterOptions,
  LaunchProviderSelection,
  SshConnectionInfo,
  WslLaunchInfo,
} from "@/types";
import type { GitChangedFile } from "@/services/gitService";

export interface PendingLaunch {
  path: string;
  workspaceName?: string;
  providerId: string;
  providerSelection?: LaunchProviderSelection;
  launchProfileId?: string;
  workspacePath?: string;
  cliTool?: CliTool;
  ssh?: SshConnectionInfo;
  wsl?: WslLaunchInfo;
  machineName?: string;
  /** 显式指定落位布局；缺省时由 workspaceName 经 findLayoutForWorkspace 推导 */
  targetLayoutId?: string;
  skipMcp?: boolean;
  appendSystemPrompt?: string;
  /** 仅首启注入；重放防护见 usePanesStore.clearTabInitialPrompt */
  initialPrompt?: string;
  /** per-launch YOLO 覆盖：undefined = 跟随 launch profile */
  yolo?: boolean;
  adapterOptions?: LaunchAdapterOptions;
}

/** 启动器打开时的上下文（入口带入的预选项） */
export interface LauncherContext {
  workspaceName?: string;
  projectPath?: string;
  targetLayoutId?: string;
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

  // Git Timeline
  gitTimelineOpen: boolean;
  gitTimelineProjectPath: string;
  gitTimelineInitialFile: GitChangedFile | null;
  openGitTimeline: (projectPath: string, initialFile?: GitChangedFile) => void;
  closeGitTimeline: () => void;

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

  // Workspace Environment
  workspaceEnvironmentOpen: boolean;
  workspaceEnvironmentWorkspaceId: string;
  openWorkspaceEnvironment: (workspaceId: string) => void;
  closeWorkspaceEnvironment: () => void;

  // Pending Launch（Settings → App 跨组件启动传递）
  pendingLaunch: PendingLaunch | null;
  setPendingLaunch: (launch: PendingLaunch) => void;
  clearPendingLaunch: () => void;

  // Launcher（全局启动器弹窗）
  launcherOpen: boolean;
  launcherContext: LauncherContext | null;
  openLauncher: (ctx?: LauncherContext) => void;
  closeLauncher: () => void;
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

  // Git Timeline
  gitTimelineOpen: false,
  gitTimelineProjectPath: "",
  gitTimelineInitialFile: null,
  openGitTimeline: (projectPath, initialFile) =>
    set({
      gitTimelineOpen: true,
      gitTimelineProjectPath: projectPath,
      gitTimelineInitialFile: initialFile ?? null,
    }),
  closeGitTimeline: () => set({ gitTimelineOpen: false, gitTimelineInitialFile: null }),

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

  // Workspace Environment
  workspaceEnvironmentOpen: false,
  workspaceEnvironmentWorkspaceId: "",
  openWorkspaceEnvironment: (workspaceId) =>
    set({
      workspaceEnvironmentOpen: true,
      workspaceEnvironmentWorkspaceId: workspaceId,
    }),
  closeWorkspaceEnvironment: () =>
    set({
      workspaceEnvironmentOpen: false,
      workspaceEnvironmentWorkspaceId: "",
    }),

  // Pending Launch
  pendingLaunch: null,
  setPendingLaunch: (launch) => set({ pendingLaunch: launch }),
  clearPendingLaunch: () => set({ pendingLaunch: null }),

  // Launcher
  launcherOpen: false,
  launcherContext: null,
  openLauncher: (ctx) => set({ launcherOpen: true, launcherContext: ctx ?? null }),
  closeLauncher: () => set({ launcherOpen: false, launcherContext: null }),
}));
