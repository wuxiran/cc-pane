import { describe, it, expect, beforeEach } from "vitest";
import { useUpdateStore } from "./useUpdateStore";

describe("useUpdateStore", () => {
  beforeEach(() => {
    useUpdateStore.setState({
      available: false,
      version: null,
      body: null,
    });
  });

  describe("初始状态", () => {
    it("应无可用更新且版本/说明为空", () => {
      const state = useUpdateStore.getState();
      expect(state.available).toBe(false);
      expect(state.version).toBeNull();
      expect(state.body).toBeNull();
    });
  });

  describe("setUpdate", () => {
    it("应设置 available 为 true 并记录版本与说明", () => {
      useUpdateStore.getState().setUpdate("1.2.3", "更新说明");

      const state = useUpdateStore.getState();
      expect(state.available).toBe(true);
      expect(state.version).toBe("1.2.3");
      expect(state.body).toBe("更新说明");
    });

    it("body 为 null 时也应正确设置", () => {
      useUpdateStore.getState().setUpdate("2.0.0", null);

      const state = useUpdateStore.getState();
      expect(state.available).toBe(true);
      expect(state.version).toBe("2.0.0");
      expect(state.body).toBeNull();
    });
  });

  describe("clearUpdate", () => {
    it("应重置为无可用更新状态", () => {
      useUpdateStore.setState({
        available: true,
        version: "1.2.3",
        body: "更新说明",
      });

      useUpdateStore.getState().clearUpdate();

      const state = useUpdateStore.getState();
      expect(state.available).toBe(false);
      expect(state.version).toBeNull();
      expect(state.body).toBeNull();
    });
  });
});
