import { describe, it, expect, beforeEach } from "vitest";
import { useDialogStore } from "./useDialogStore";

describe("useDialogStore", () => {
  beforeEach(() => {
    useDialogStore.setState({
      settingsOpen: false,
      journalOpen: false,
      journalWorkspaceName: "",
      localHistoryOpen: false,
      localHistoryProjectPath: "",
      localHistoryFilePath: "",
      gitTimelineOpen: false,
      gitTimelineProjectPath: "",
      gitTimelineInitialFile: null,
      sessionCleanerOpen: false,
      sessionCleanerProjectPath: "",
      todoOpen: false,
      todoScope: "",
      todoScopeRef: "",
    });
  });

  describe("初始状态", () => {
    it("所有 dialog 应全部关闭", () => {
      const state = useDialogStore.getState();
      expect(state.settingsOpen).toBe(false);
      expect(state.journalOpen).toBe(false);
      expect(state.journalWorkspaceName).toBe("");
      expect(state.localHistoryOpen).toBe(false);
      expect(state.localHistoryProjectPath).toBe("");
      expect(state.localHistoryFilePath).toBe("");
      expect(state.sessionCleanerOpen).toBe(false);
      expect(state.sessionCleanerProjectPath).toBe("");
      expect(state.todoOpen).toBe(false);
      expect(state.todoScope).toBe("");
      expect(state.todoScopeRef).toBe("");
    });
  });

  describe("Settings dialog", () => {
    it("openSettings 应设置 settingsOpen 为 true", () => {
      useDialogStore.getState().openSettings();
      expect(useDialogStore.getState().settingsOpen).toBe(true);
    });

    it("closeSettings 应设置 settingsOpen 为 false", () => {
      useDialogStore.setState({ settingsOpen: true });
      useDialogStore.getState().closeSettings();
      expect(useDialogStore.getState().settingsOpen).toBe(false);
    });
  });

  describe("Journal dialog", () => {
    it("openJournal 应设置 journalOpen 和 journalWorkspaceName", () => {
      useDialogStore.getState().openJournal("my-workspace");

      const state = useDialogStore.getState();
      expect(state.journalOpen).toBe(true);
      expect(state.journalWorkspaceName).toBe("my-workspace");
    });

    it("closeJournal 应设置 journalOpen 为 false", () => {
      useDialogStore.setState({
        journalOpen: true,
        journalWorkspaceName: "my-workspace",
      });

      useDialogStore.getState().closeJournal();

      const state = useDialogStore.getState();
      expect(state.journalOpen).toBe(false);
      // closeJournal 不清理 workspaceName（符合实现）
    });
  });

  describe("Local History dialog", () => {
    it("openLocalHistory 应设置 localHistoryOpen 和 localHistoryProjectPath", () => {
      useDialogStore.getState().openLocalHistory("/path/to/project");

      const state = useDialogStore.getState();
      expect(state.localHistoryOpen).toBe(true);
      expect(state.localHistoryProjectPath).toBe("/path/to/project");
      expect(state.localHistoryFilePath).toBe("");
    });

    it("openLocalHistory 带 filePath 应同时设置 localHistoryFilePath", () => {
      useDialogStore.getState().openLocalHistory("/path/to/project", "src/main.ts");

      const state = useDialogStore.getState();
      expect(state.localHistoryOpen).toBe(true);
      expect(state.localHistoryProjectPath).toBe("/path/to/project");
      expect(state.localHistoryFilePath).toBe("src/main.ts");
    });

    it("closeLocalHistory 应设置 localHistoryOpen 为 false 并清空 filePath", () => {
      useDialogStore.setState({
        localHistoryOpen: true,
        localHistoryProjectPath: "/path/to/project",
        localHistoryFilePath: "src/main.ts",
      });

      useDialogStore.getState().closeLocalHistory();
      expect(useDialogStore.getState().localHistoryOpen).toBe(false);
      expect(useDialogStore.getState().localHistoryFilePath).toBe("");
    });
  });

  describe("Session Cleaner dialog", () => {
    it("openSessionCleaner 应设置 sessionCleanerOpen 和 sessionCleanerProjectPath", () => {
      useDialogStore.getState().openSessionCleaner("/another/project");

      const state = useDialogStore.getState();
      expect(state.sessionCleanerOpen).toBe(true);
      expect(state.sessionCleanerProjectPath).toBe("/another/project");
    });

    it("closeSessionCleaner 应设置 sessionCleanerOpen 为 false", () => {
      useDialogStore.setState({
        sessionCleanerOpen: true,
        sessionCleanerProjectPath: "/another/project",
      });

      useDialogStore.getState().closeSessionCleaner();
      expect(useDialogStore.getState().sessionCleanerOpen).toBe(false);
    });
  });

  describe("Git Timeline dialog", () => {
    it("携带结构化文件打开并在关闭时清理", () => {
      const file = {
        status: "renamed" as const,
        oldPath: "old.txt",
        newPath: "new.txt",
        oldMode: "100644",
        newMode: "100644",
      };
      useDialogStore.getState().openGitTimeline("/repo", file);
      expect(useDialogStore.getState()).toMatchObject({
        gitTimelineOpen: true,
        gitTimelineProjectPath: "/repo",
        gitTimelineInitialFile: file,
      });

      useDialogStore.getState().closeGitTimeline();
      expect(useDialogStore.getState().gitTimelineOpen).toBe(false);
      expect(useDialogStore.getState().gitTimelineInitialFile).toBeNull();
    });
  });

  describe("Launcher dialog", () => {
    it("openLauncher 无上下文时 launcherContext 为 null", () => {
      useDialogStore.getState().openLauncher();
      const state = useDialogStore.getState();
      expect(state.launcherOpen).toBe(true);
      expect(state.launcherContext).toBeNull();
    });

    it("openLauncher 带上下文时保存 workspaceName/targetLayoutId", () => {
      useDialogStore.getState().openLauncher({ workspaceName: "demo", targetLayoutId: "layout-1" });
      const state = useDialogStore.getState();
      expect(state.launcherOpen).toBe(true);
      expect(state.launcherContext).toEqual({ workspaceName: "demo", targetLayoutId: "layout-1" });
    });

    it("closeLauncher 关闭并清空上下文", () => {
      useDialogStore.getState().openLauncher({ workspaceName: "demo" });
      useDialogStore.getState().closeLauncher();
      const state = useDialogStore.getState();
      expect(state.launcherOpen).toBe(false);
      expect(state.launcherContext).toBeNull();
    });
  });

  describe("Pending Launch extras", () => {
    it("setPendingLaunch 透传启动器附加字段", () => {
      useDialogStore.getState().setPendingLaunch({
        path: "D:/repos/demo",
        providerId: "",
        skipMcp: true,
        appendSystemPrompt: "focus",
        initialPrompt: "run tests",
        yolo: true,
        adapterOptions: { effort: "high", maxTurns: 3 },
      });
      expect(useDialogStore.getState().pendingLaunch).toMatchObject({
        skipMcp: true,
        appendSystemPrompt: "focus",
        initialPrompt: "run tests",
        yolo: true,
        adapterOptions: { effort: "high", maxTurns: 3 },
      });
      useDialogStore.getState().clearPendingLaunch();
      expect(useDialogStore.getState().pendingLaunch).toBeNull();
    });
  });

  describe("Todo dialog", () => {
    it("openTodo 应设置 todoOpen、todoScope 和 todoScopeRef", () => {
      useDialogStore.getState().openTodo("workspace", "my-workspace");

      const state = useDialogStore.getState();
      expect(state.todoOpen).toBe(true);
      expect(state.todoScope).toBe("workspace");
      expect(state.todoScopeRef).toBe("my-workspace");
    });

    it("closeTodo 应设置 todoOpen 为 false", () => {
      useDialogStore.setState({
        todoOpen: true,
        todoScope: "workspace",
        todoScopeRef: "my-workspace",
      });

      useDialogStore.getState().closeTodo();
      expect(useDialogStore.getState().todoOpen).toBe(false);
    });
  });
});
