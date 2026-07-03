import { describe, it, expect, beforeEach } from "vitest";
import { useVoiceInputStore } from "./useVoiceInputStore";

describe("useVoiceInputStore", () => {
  beforeEach(() => {
    useVoiceInputStore.setState({
      activeTargetId: null,
      toggleRequest: null,
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useVoiceInputStore.getState();
      expect(state.activeTargetId).toBeNull();
      expect(state.toggleRequest).toBeNull();
    });
  });

  describe("setActiveTarget", () => {
    it("应该设置 activeTargetId", () => {
      useVoiceInputStore.getState().setActiveTarget("target-1");
      expect(useVoiceInputStore.getState().activeTargetId).toBe("target-1");
    });

    it("应该覆盖之前的 activeTargetId", () => {
      useVoiceInputStore.getState().setActiveTarget("target-1");
      useVoiceInputStore.getState().setActiveTarget("target-2");
      expect(useVoiceInputStore.getState().activeTargetId).toBe("target-2");
    });
  });

  describe("clearActiveTarget", () => {
    it("不带参数时应清空 activeTargetId", () => {
      useVoiceInputStore.setState({ activeTargetId: "target-1" });
      useVoiceInputStore.getState().clearActiveTarget();
      expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
    });

    it("传入匹配的 targetId 时应清空", () => {
      useVoiceInputStore.setState({ activeTargetId: "target-1" });
      useVoiceInputStore.getState().clearActiveTarget("target-1");
      expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
    });

    it("传入不匹配的 targetId 时应保持不变", () => {
      useVoiceInputStore.setState({ activeTargetId: "target-1" });
      useVoiceInputStore.getState().clearActiveTarget("target-2");
      expect(useVoiceInputStore.getState().activeTargetId).toBe("target-1");
    });

    it("activeTargetId 为 null 时传入 targetId 仍会清空为 null", () => {
      // activeTargetId 为 null，传入 targetId 与 null 不等 → 直接返回，保持 null
      useVoiceInputStore.setState({ activeTargetId: null });
      useVoiceInputStore.getState().clearActiveTarget("target-x");
      expect(useVoiceInputStore.getState().activeTargetId).toBeNull();
    });
  });

  describe("requestToggle", () => {
    it("首次请求应创建 seq 为 1 的 toggleRequest", () => {
      useVoiceInputStore.getState().requestToggle("target-1");
      const req = useVoiceInputStore.getState().toggleRequest;
      expect(req).toEqual({ targetId: "target-1", seq: 1 });
    });

    it("连续请求应递增 seq", () => {
      const store = useVoiceInputStore.getState();
      store.requestToggle("target-1");
      store.requestToggle("target-1");
      store.requestToggle("target-2");

      const req = useVoiceInputStore.getState().toggleRequest;
      expect(req).toEqual({ targetId: "target-2", seq: 3 });
    });

    it("不同 targetId 的请求也共享递增的 seq", () => {
      const store = useVoiceInputStore.getState();
      store.requestToggle("a");
      store.requestToggle("b");
      expect(useVoiceInputStore.getState().toggleRequest?.seq).toBe(2);
    });
  });
});
