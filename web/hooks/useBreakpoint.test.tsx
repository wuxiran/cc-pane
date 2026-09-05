import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useBreakpoint, useMediaUp } from "./useBreakpoint";

function setWidth(width: number) {
  act(() => {
    window.innerWidth = width;
    window.dispatchEvent(new Event("resize"));
  });
}

describe("useBreakpoint", () => {
  afterEach(() => setWidth(1024));

  it("返回当前窗口宽度所属档位", () => {
    setWidth(500);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe("xs");

    setWidth(800);
    expect(result.current).toBe("md");
  });

  it("同一档内 resize 不触发状态变化", () => {
    setWidth(800);
    const { result } = renderHook(() => useBreakpoint());
    const before = result.current;
    setWidth(900);
    expect(result.current).toBe(before);
  });
});

describe("useMediaUp", () => {
  it("达到断点（含）返回 true", () => {
    setWidth(768);
    const { result } = renderHook(() => useMediaUp("md"));
    expect(result.current).toBe(true);

    setWidth(767);
    expect(result.current).toBe(false);
  });
});
