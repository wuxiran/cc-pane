import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

type ChangeHandler = (event: MediaQueryListEvent) => void;

/** 最小 matchMedia stub：记录 change 监听器，允许测试手动触发。 */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<ChangeHandler>();
  const mql = {
    matches: initial,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, handler: ChangeHandler) => listeners.add(handler),
    removeEventListener: (_: string, handler: ChangeHandler) => listeners.delete(handler),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
  return {
    setMatches(next: boolean) {
      (mql as { matches: boolean }).matches = next;
      act(() => {
        listeners.forEach((handler) =>
          handler({ matches: next } as MediaQueryListEvent),
        );
      });
    },
  };
}

describe("usePrefersReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("无 matchMedia 的环境（jsdom 默认）按全动效处理", () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("系统开启减弱动效时返回 true", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("跟随系统开关变化", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    media.setMatches(true);
    expect(result.current).toBe(true);
    media.setMatches(false);
    expect(result.current).toBe(false);
  });
});
