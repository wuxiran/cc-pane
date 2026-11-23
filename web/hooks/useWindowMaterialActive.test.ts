import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useWindowMaterialActive } from "./useWindowMaterialActive";

describe("useWindowMaterialActive", () => {
  afterEach(() => {
    delete document.documentElement.dataset.material;
  });

  it("跟随 <html data-material> 变化", async () => {
    const { result } = renderHook(() => useWindowMaterialActive());
    expect(result.current).toBe(false);
    await act(async () => {
      document.documentElement.dataset.material = "on";
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
  });
});
