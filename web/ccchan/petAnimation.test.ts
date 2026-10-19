import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePetAnimationFrame } from "./petAnimation";
import type { PetMeta } from "./types";

const pet = {
  id: "test-pet",
  animations: { idle: { row: 0, frames: 4, fps: 2 } },
} as unknown as PetMeta;

describe("usePetAnimationFrame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("advances at the sprite fps without requestAnimationFrame", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { result } = renderHook(() => usePetAnimationFrame(pet, "idle"));
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current).toBe(1);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(result.current).toBe(0);
    expect(raf).not.toHaveBeenCalled();
  });

  it("pauses while the page is hidden", () => {
    const { result } = renderHook(() => usePetAnimationFrame(pet, "idle"));
    act(() => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(0);
  });
});
