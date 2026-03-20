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
