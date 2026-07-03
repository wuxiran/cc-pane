import { describe, it, expect, beforeEach } from "vitest";
import { useSelfChatStore } from "./useSelfChatStore";

describe("useSelfChatStore", () => {
  beforeEach(() => {
    useSelfChatStore.setState({ activeSession: null, isOnboarding: false });
  });

  describe("初始状态", () => {
    it("应无活动会话且非 onboarding", () => {
      const state = useSelfChatStore.getState();
      expect(state.activeSession).toBeNull();
      expect(state.isOnboarding).toBe(false);
    });
  });

  describe("startSession", () => {
    it("应创建 initializing 状态的会话并返回其 id", () => {
      const id = useSelfChatStore
        .getState()
        .startSession("/app/cwd", "system prompt");

      const session = useSelfChatStore.getState().activeSession;
      expect(session).not.toBeNull();
      expect(session?.id).toBe(id);
      expect(session?.appCwd).toBe("/app/cwd");
      expect(session?.systemPrompt).toBe("system prompt");
      expect(session?.ptySessionId).toBeNull();
      expect(session?.status).toBe("initializing");
    });

    it("systemPrompt 允许为 null", () => {
      useSelfChatStore.getState().startSession("/app/cwd", null);
      expect(useSelfChatStore.getState().activeSession?.systemPrompt).toBeNull();
    });

    it("每次生成的 id 应唯一", () => {
      const id1 = useSelfChatStore.getState().startSession("/a", null);
      const id2 = useSelfChatStore.getState().startSession("/b", null);
      expect(id1).not.toBe(id2);
    });
  });

  describe("updatePtySessionId", () => {
    it("id 匹配时应更新 ptySessionId", () => {
      const id = useSelfChatStore.getState().startSession("/app", null);

      useSelfChatStore.getState().updatePtySessionId(id, "pty-123");

      expect(useSelfChatStore.getState().activeSession?.ptySessionId).toBe(
        "pty-123",
      );
    });

    it("id 不匹配时应保持不变", () => {
      const id = useSelfChatStore.getState().startSession("/app", null);
      useSelfChatStore.getState().updatePtySessionId("other-id", "pty-123");

      const session = useSelfChatStore.getState().activeSession;
      expect(session?.id).toBe(id);
      expect(session?.ptySessionId).toBeNull();
    });

    it("无活动会话时应不抛出", () => {
      expect(() =>
        useSelfChatStore.getState().updatePtySessionId("x", "pty"),
      ).not.toThrow();
      expect(useSelfChatStore.getState().activeSession).toBeNull();
    });
  });

  describe("setStatus", () => {
    it("id 匹配时应更新 status", () => {
      const id = useSelfChatStore.getState().startSession("/app", null);

      useSelfChatStore.getState().setStatus(id, "running");

      expect(useSelfChatStore.getState().activeSession?.status).toBe("running");
    });

    it("id 不匹配时应保持不变", () => {
      const id = useSelfChatStore.getState().startSession("/app", null);
      useSelfChatStore.getState().setStatus("other", "running");

      const session = useSelfChatStore.getState().activeSession;
      expect(session?.id).toBe(id);
      expect(session?.status).toBe("initializing");
    });
  });

  describe("endSession", () => {
    it("id 匹配时应清空会话并复位 onboarding", () => {
      const id = useSelfChatStore.getState().startSession("/app", null);
      useSelfChatStore.getState().setOnboarding(true);

      useSelfChatStore.getState().endSession(id);

      const state = useSelfChatStore.getState();
      expect(state.activeSession).toBeNull();
      expect(state.isOnboarding).toBe(false);
    });

    it("id 不匹配时应保留会话与 onboarding", () => {
      const id = useSelfChatStore.getState().startSession("/app", null);
      useSelfChatStore.getState().setOnboarding(true);

      useSelfChatStore.getState().endSession("other-id");

      const state = useSelfChatStore.getState();
      expect(state.activeSession?.id).toBe(id);
      expect(state.isOnboarding).toBe(true);
    });
  });

  describe("setOnboarding", () => {
    it("应更新 isOnboarding 标志", () => {
      useSelfChatStore.getState().setOnboarding(true);
      expect(useSelfChatStore.getState().isOnboarding).toBe(true);

      useSelfChatStore.getState().setOnboarding(false);
      expect(useSelfChatStore.getState().isOnboarding).toBe(false);
    });
  });
});
