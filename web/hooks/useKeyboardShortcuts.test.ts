import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@/stores", () => ({
  handleKeydown: vi.fn(),
}));

import { handleKeydown } from "@/stores";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mount 后应该注册 keydown 事件到 window（capture=true）", () => {
    const addSpy = vi.spyOn(window, "addEventListener");

    renderHook(() => useKeyboardShortcuts());

    expect(addSpy).toHaveBeenCalledWith("keydown", handleKeydown, true);

    addSpy.mockRestore();
  });

  it("触发 keydown 事件时应该调用 handleKeydown", () => {
    renderHook(() => useKeyboardShortcuts());

    const event = new KeyboardEvent("keydown", { key: "a" });
    window.dispatchEvent(event);

    expect(handleKeydown).toHaveBeenCalledTimes(1);
    expect(handleKeydown).toHaveBeenCalledWith(expect.any(KeyboardEvent));
  });

  it("unmount 后 keydown 事件应该被移除", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useKeyboardShortcuts());
    unmount();

    expect(removeSpy).toHaveBeenCalledWith("keydown", handleKeydown, true);

    // 验证事件确实不再触发
    (handleKeydown as ReturnType<typeof vi.fn>).mockClear();
    const event = new KeyboardEvent("keydown", { key: "b" });
    window.dispatchEvent(event);
    expect(handleKeydown).not.toHaveBeenCalled();

    removeSpy.mockRestore();
  });

  it("重新 mount 不会重复注册监听器", () => {
    const addSpy = vi.spyOn(window, "addEventListener");

    const { unmount } = renderHook(() => useKeyboardShortcuts());
    unmount();

    addSpy.mockClear();

    renderHook(() => useKeyboardShortcuts());

    // 只注册一次
    const keydownCalls = addSpy.mock.calls.filter(
      (call) => call[0] === "keydown" && call[1] === handleKeydown,
    );
    expect(keydownCalls).toHaveLength(1);

    addSpy.mockRestore();
  });

  it("多次触发 keydown 事件都应该被正确处理", () => {
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));

    expect(handleKeydown).toHaveBeenCalledTimes(3);
  });
});
