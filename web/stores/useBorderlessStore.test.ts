import { describe, it, expect, beforeEach, vi } from "vitest";
import { useBorderlessStore } from "./useBorderlessStore";
import {
  mockTauriInvoke,
  resetTauriInvoke,
} from "@/test/utils/mockTauriInvoke";

describe("useBorderlessStore", () => {
  beforeEach(() => {
    resetTauriInvoke();
    useBorderlessStore.setState({ isBorderless: true });
  });

  describe("初始状态", () => {
    it("isBorderless 默认为 true", () => {
      expect(useBorderlessStore.getState().isBorderless).toBe(true);
    });
  });

  describe("toggleBorderless", () => {
    it("从 borderless 切换到非 borderless（decorations=true）", async () => {
      mockTauriInvoke({ set_decorations: undefined });

      await useBorderlessStore.getState().toggleBorderless();

      expect(useBorderlessStore.getState().isBorderless).toBe(false);
    });

    it("从非 borderless 切换到 borderless（decorations=false）", async () => {
      useBorderlessStore.setState({ isBorderless: false });
      mockTauriInvoke({ set_decorations: undefined });

      await useBorderlessStore.getState().toggleBorderless();

      expect(useBorderlessStore.getState().isBorderless).toBe(true);
    });

    it("invoke 失败时不应崩溃且状态不变", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockTauriInvoke({
        set_decorations: () => {
          throw new Error("fail");
        },
      });

      await useBorderlessStore.getState().toggleBorderless();

      // invoke 失败，set 未执行，保持原始值
      expect(useBorderlessStore.getState().isBorderless).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe("exitBorderless", () => {
    it("当前为 borderless 时应退出并设置 decorations", async () => {
      mockTauriInvoke({ set_decorations: undefined });

      await useBorderlessStore.getState().exitBorderless();

      expect(useBorderlessStore.getState().isBorderless).toBe(false);
    });

    it("当前非 borderless 时应直接返回不调用 invoke", async () => {
      useBorderlessStore.setState({ isBorderless: false });
      // 不设置任何 mock handler，如果 invoke 被调用会报错
      mockTauriInvoke({});

      await useBorderlessStore.getState().exitBorderless();

      expect(useBorderlessStore.getState().isBorderless).toBe(false);
    });

    it("invoke 失败时不应崩溃", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockTauriInvoke({
        set_decorations: () => {
          throw new Error("fail");
        },
      });

      await useBorderlessStore.getState().exitBorderless();

      expect(useBorderlessStore.getState().isBorderless).toBe(true);
      consoleSpy.mockRestore();
    });
  });
});
